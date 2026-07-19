-- Wave 3 · Phase 3 — pos_payment_session_commit returns full jsonb envelope.
-- Return-type change requires DROP + CREATE.

DROP FUNCTION IF EXISTS public.pos_payment_session_commit(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.pos_payment_session_commit(
  p_session_id            uuid,
  p_transaction_envelope  jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session   public.pos_payment_sessions%ROWTYPE;
  v_apply     public.pos_payment_session_apply_log%ROWTYPE;
  v_payments  jsonb;
  v_response  jsonb;
  v_txn_id    uuid;
  v_allocated numeric;
BEGIN
  SELECT * INTO v_session FROM public.pos_payment_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_commit: unknown session %', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_session.branch_id);

  -- Idempotent replay: return the cached process_pos_transaction envelope.
  SELECT * INTO v_apply FROM public.pos_payment_session_apply_log WHERE session_id = p_session_id;
  IF FOUND THEN
    SELECT response INTO v_response
      FROM public.pos_transaction_idempotency
     WHERE idempotency_key = v_session.idempotency_key
     LIMIT 1;
    IF v_response IS NULL THEN
      -- Legacy row without cached response — synthesise a minimal envelope.
      v_response := jsonb_build_object(
        'success', true, 'idempotent_replay', true,
        'transaction_id', v_apply.transaction_id);
    END IF;
    RETURN v_response || jsonb_build_object('session_id', p_session_id);
  END IF;

  IF v_session.status IN ('cancelled','abandoned') THEN
    RAISE EXCEPTION 'pos_payment_session_commit: session % is %', p_session_id, v_session.status
      USING ERRCODE = 'check_violation';
  END IF;

  v_allocated := public.pos_payment_session_allocated(p_session_id);
  IF v_allocated < (v_session.grand_total + v_session.tip_amount) - 0.0001 THEN
    RAISE EXCEPTION 'pos_payment_session_commit: session % not balanced (% of %)',
      p_session_id, v_allocated, v_session.grand_total + v_session.tip_amount
      USING ERRCODE = 'check_violation';
  END IF;

  -- Materialise live (non-reversed / non-failed) tenders as the payments jsonb array
  -- expected by process_pos_transaction. Preserves tendered_amount / change_given
  -- per ADR-0009 and passes card FSM metadata through to _pos_record_payment.
  SELECT jsonb_agg(jsonb_build_object(
    'payment_method',   t.method_key,
    'tender_kind',      t.tender_kind,
    'amount',           t.amount,
    'tendered_amount',  t.tendered_amount,
    'change_given',     t.change_given,
    'reference',        t.reference,
    'auth_state',       t.auth_state::text,
    'auth_id',          t.auth_id,
    'vendor_txn_id',    t.vendor_txn_id
  ))
    INTO v_payments
    FROM public.pos_payment_session_tenders t
   WHERE t.session_id = p_session_id
     AND t.auth_state NOT IN ('reversed','failed');

  -- Delegate the transaction+ledger commit to the canonical RPC.
  -- process_pos_transaction returns a jsonb envelope with { success, error, ... }.
  v_response := public.process_pos_transaction(
    p_organization_id        := v_session.organization_id,
    p_business_id            := v_session.business_id,
    p_register_id            := v_session.register_id,
    p_shift_id               := (p_transaction_envelope->>'shift_id')::uuid,
    p_items                  := p_transaction_envelope->'items',
    p_payments               := v_payments,
    p_subtotal               := (p_transaction_envelope->>'subtotal')::numeric,
    p_tax_amount             := (p_transaction_envelope->>'tax_amount')::numeric,
    p_discount_amount        := COALESCE((p_transaction_envelope->>'discount_amount')::numeric, 0),
    p_total                  := v_session.grand_total,
    p_transaction_type       := COALESCE(p_transaction_envelope->>'transaction_type','sale'),
    p_customer_id            := NULLIF(p_transaction_envelope->>'customer_id','')::uuid,
    p_customer_tin           := p_transaction_envelope->>'customer_tin',
    p_customer_name          := p_transaction_envelope->>'customer_name',
    p_notes                  := p_transaction_envelope->>'notes',
    p_cashier_id             := v_session.cashier_id,
    p_created_by             := auth.uid(),
    p_original_transaction_id:= NULLIF(p_transaction_envelope->>'original_transaction_id','')::uuid,
    p_tip_amount             := v_session.tip_amount,
    p_table_session_id       := NULLIF(p_transaction_envelope->>'table_session_id','')::uuid,
    p_idempotency_key        := v_session.idempotency_key
  );

  -- process_pos_transaction returns a structured error envelope on business
  -- failures (insufficient_stock, no_payments, ...). Bubble as an exception
  -- so the outer transaction rolls back and the session isn't marked committed.
  IF NOT COALESCE((v_response->>'success')::boolean, false) THEN
    RAISE EXCEPTION 'pos_payment_session_commit: process_pos_transaction failed: %',
      COALESCE(v_response->>'error','unknown')
      USING ERRCODE = 'raise_exception',
            HINT   = v_response::text;
  END IF;

  v_txn_id := (v_response->>'transaction_id')::uuid;

  UPDATE public.pos_payment_sessions
     SET status             = 'committed',
         pos_transaction_id = v_txn_id,
         closed_at          = now()
   WHERE id = p_session_id;

  -- Apply-log is the last write so a rollback leaves no ghost log row.
  INSERT INTO public.pos_payment_session_apply_log (session_id, transaction_id, applied_by)
  VALUES (p_session_id, v_txn_id, auth.uid());

  PERFORM public._pos_payment_session_emit(
    'pos.payment.session.committed',
    (SELECT s FROM public.pos_payment_sessions s WHERE s.id = p_session_id),
    jsonb_build_object('session_id', p_session_id, 'transaction_id', v_txn_id,
                       'idempotency_key', v_session.idempotency_key)
  );

  RETURN v_response || jsonb_build_object('session_id', p_session_id);
END $$;

COMMENT ON FUNCTION public.pos_payment_session_commit(uuid, jsonb) IS
  'Wave 3 Phase 3 — returns the full process_pos_transaction envelope augmented with session_id. Replays via the apply-log return the cached envelope so a retried commit is indistinguishable from the first call.';