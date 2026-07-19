-- Wave 3 · Phase 4.a — Restaurant commit onto the payment-session lifecycle.
--
-- Extend pos_payment_session_commit to support two commit modes:
--
--   1. Retail (envelope has NO existing_transaction_id — current behaviour):
--      materialise tenders → call process_pos_transaction → mark session
--      committed → write apply-log.
--
--   2. Restaurant / table order (envelope has existing_transaction_id):
--      materialise tenders → call finalize_table_order(p_transaction_id, ...)
--      against the already-open draft transaction → mark session committed
--      → write apply-log with the same transaction_id.
--
-- Idempotency, apply-log guard, branch access guard, business-event emission,
-- and the committed-envelope shape returned to the client are identical for
-- both modes. This is the single write path into pos_transaction_payments
-- from the client tier from now on.

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
  v_existing  uuid;
BEGIN
  SELECT * INTO v_session FROM public.pos_payment_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_commit: unknown session %', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_session.branch_id);

  SELECT * INTO v_apply FROM public.pos_payment_session_apply_log WHERE session_id = p_session_id;
  IF FOUND THEN
    SELECT response INTO v_response
      FROM public.pos_transaction_idempotency
     WHERE idempotency_key = v_session.idempotency_key
     LIMIT 1;
    IF v_response IS NULL THEN
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

  -- Materialise tenders into the payments jsonb array. Card metadata +
  -- mpesa receipt live in driver_payload on the tender row and get promoted
  -- to top-level fields here so downstream (_pos_record_payment for retail,
  -- finalize_table_order for restaurant) inserts them onto the row.
  SELECT jsonb_agg(jsonb_build_object(
    'payment_method',        t.method_key,
    'tender_kind',           t.tender_kind,
    'amount',                t.amount,
    'tendered_amount',       t.tendered_amount,
    'change_given',          t.change_given,
    'reference',             t.reference,
    'auth_state',            t.auth_state::text,
    'auth_id',               t.auth_id,
    'vendor_txn_id',         t.vendor_txn_id,
    'card_last_four',        t.driver_payload->>'card_last_four',
    'card_type',             t.driver_payload->>'card_type',
    'authorized_amount',     NULLIF(t.driver_payload->>'authorized_amount','')::numeric,
    'mpesa_receipt_number',  CASE WHEN t.method_key = 'mobile_money' THEN t.reference ELSE NULL END
  ))
    INTO v_payments
    FROM public.pos_payment_session_tenders t
   WHERE t.session_id = p_session_id
     AND t.auth_state NOT IN ('reversed','failed');

  v_existing := NULLIF(p_transaction_envelope->>'existing_transaction_id','')::uuid;

  IF v_existing IS NOT NULL THEN
    -- Restaurant / table-order commit: finalize the pre-existing draft
    -- transaction. finalize_table_order handles stock consumption,
    -- payment row inserts, and status transition; we just forward the
    -- session's materialised tenders + tip.
    v_response := public.finalize_table_order(
      p_transaction_id := v_existing,
      p_payments       := v_payments,
      p_tip_amount     := v_session.tip_amount,
      p_created_by     := auth.uid()
    );

    IF NOT COALESCE((v_response->>'success')::boolean, false) THEN
      RAISE EXCEPTION 'pos_payment_session_commit: finalize_table_order failed: %',
        COALESCE(v_response->>'error','unknown')
        USING ERRCODE = 'raise_exception',
              HINT   = v_response::text;
    END IF;

    v_txn_id := COALESCE(
      NULLIF(v_response->>'transaction_id','')::uuid,
      v_existing
    );
  ELSE
    -- Retail commit: create a new transaction from the envelope's cart.
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

    IF NOT COALESCE((v_response->>'success')::boolean, false) THEN
      RAISE EXCEPTION 'pos_payment_session_commit: process_pos_transaction failed: %',
        COALESCE(v_response->>'error','unknown')
        USING ERRCODE = 'raise_exception',
              HINT   = v_response::text;
    END IF;

    v_txn_id := (v_response->>'transaction_id')::uuid;
  END IF;

  UPDATE public.pos_payment_sessions
     SET status             = 'committed',
         pos_transaction_id = v_txn_id,
         closed_at          = now()
   WHERE id = p_session_id;

  INSERT INTO public.pos_payment_session_apply_log (session_id, transaction_id, applied_by)
  VALUES (p_session_id, v_txn_id, auth.uid());

  PERFORM public._pos_payment_session_emit(
    'pos.payment.session.committed',
    (SELECT s FROM public.pos_payment_sessions s WHERE s.id = p_session_id),
    jsonb_build_object('session_id', p_session_id, 'transaction_id', v_txn_id,
                       'idempotency_key', v_session.idempotency_key,
                       'commit_mode', CASE WHEN v_existing IS NULL THEN 'retail' ELSE 'table_order' END)
  );

  RETURN v_response || jsonb_build_object('session_id', p_session_id);
END $$;