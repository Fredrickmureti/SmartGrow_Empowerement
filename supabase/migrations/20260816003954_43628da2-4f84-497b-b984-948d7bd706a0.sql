-- =====================================================================
-- POS Wave · Phase 7 — Payment integrity
-- =====================================================================
-- 7.1 Tender hygiene: change belongs to cash only; non-cash tendered == amount.
ALTER TABLE public.pos_payment_session_tenders
  DROP CONSTRAINT IF EXISTS pos_payment_session_tenders_change_cash_only;
ALTER TABLE public.pos_payment_session_tenders
  ADD CONSTRAINT pos_payment_session_tenders_change_cash_only
  CHECK (change_given = 0 OR tender_kind = 'cash') NOT VALID;

ALTER TABLE public.pos_payment_session_tenders
  DROP CONSTRAINT IF EXISTS pos_payment_session_tenders_noncash_exact;
ALTER TABLE public.pos_payment_session_tenders
  ADD CONSTRAINT pos_payment_session_tenders_noncash_exact
  CHECK (tender_kind = 'cash' OR abs(tendered_amount - amount) <= 0.0001) NOT VALID;

-- 7.2 Commit: re-derive the payable total server-side and fail closed.
CREATE OR REPLACE FUNCTION public.pos_payment_session_commit(
  p_session_id uuid, p_transaction_envelope jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session   public.pos_payment_sessions%ROWTYPE;
  v_apply     public.pos_payment_session_apply_log%ROWTYPE;
  v_payments  jsonb;
  v_response  jsonb;
  v_txn_id    uuid;
  v_allocated numeric;
  v_existing  uuid;
  v_quote     jsonb;
  v_items     jsonb;
  v_authoritative_total numeric;
  v_draft_total numeric;
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

  v_existing := NULLIF(p_transaction_envelope->>'existing_transaction_id','')::uuid;
  v_items    := COALESCE(p_transaction_envelope->'items', '[]'::jsonb);

  -- ---------------------------------------------------------------
  -- Phase 7 · money authority at the commit boundary.
  -- `grand_total` reaches the session from the terminal at open time.
  -- Before any money moves we re-derive the payable amount from the
  -- canonical resolvers and refuse the commit on any disagreement.
  -- ---------------------------------------------------------------
  IF v_existing IS NOT NULL THEN
    -- Restaurant: the draft is already server-priced by pos_sync_table_order.
    SELECT total INTO v_draft_total
      FROM public.pos_transactions WHERE id = v_existing;
    IF v_draft_total IS NULL THEN
      RAISE EXCEPTION 'pos_payment_session_commit: draft transaction % not found', v_existing
        USING ERRCODE = 'no_data_found';
    END IF;
    v_authoritative_total := v_draft_total;
  ELSIF jsonb_array_length(v_items) > 0 THEN
    v_quote := public.pos_quote_cart(
      p_register_id         := v_session.register_id,
      p_lines               := v_items,
      p_contact_id          := NULLIF(p_transaction_envelope->>'customer_id','')::uuid,
      p_cart_discount_type  := NULLIF(p_transaction_envelope->>'cart_discount_type',''),
      p_cart_discount_value := COALESCE((p_transaction_envelope->>'cart_discount_value')::numeric, 0)
    );
    v_authoritative_total := (v_quote->>'total')::numeric;
  END IF;

  IF v_authoritative_total IS NOT NULL
     AND abs(v_authoritative_total - v_session.grand_total) > 0.01 THEN
    RAISE EXCEPTION
      'pos_payment_session_commit: total mismatch — session % declares %, server prices %',
      p_session_id, v_session.grand_total, v_authoritative_total
      USING ERRCODE = 'check_violation',
            HINT = 'The cart changed after the payment session was opened, or the '
                   'client total is not server-derived. Re-open the session with the '
                   'quoted total.';
  END IF;

  v_allocated := public.pos_payment_session_allocated(p_session_id);
  IF v_allocated < (v_session.grand_total + v_session.tip_amount) - 0.0001 THEN
    RAISE EXCEPTION 'pos_payment_session_commit: session % not balanced (% of %)',
      p_session_id, v_allocated, v_session.grand_total + v_session.tip_amount
      USING ERRCODE = 'check_violation';
  END IF;

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

  IF v_existing IS NOT NULL THEN
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

    v_txn_id := COALESCE(NULLIF(v_response->>'transaction_id','')::uuid, v_existing);
  ELSE
    v_response := public.process_pos_transaction(
      p_organization_id        := v_session.organization_id,
      p_business_id            := v_session.business_id,
      p_register_id            := v_session.register_id,
      p_shift_id               := (p_transaction_envelope->>'shift_id')::uuid,
      p_items                  := v_items,
      p_payments               := v_payments,
      p_subtotal               := COALESCE((v_quote->>'subtotal')::numeric,
                                           (p_transaction_envelope->>'subtotal')::numeric),
      p_tax_amount             := COALESCE((v_quote->>'tax_amount')::numeric,
                                           (p_transaction_envelope->>'tax_amount')::numeric),
      p_discount_amount        := COALESCE((v_quote->>'discount_amount')::numeric,
                                           (p_transaction_envelope->>'discount_amount')::numeric, 0),
      p_total                  := COALESCE(v_authoritative_total, v_session.grand_total),
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
                       'server_total', v_authoritative_total,
                       'commit_mode', CASE WHEN v_existing IS NULL THEN 'retail' ELSE 'table_order' END)
  );

  RETURN v_response || jsonb_build_object('session_id', p_session_id);
END $function$;

-- 7.3 Cancel: never discard captured non-cash money implicitly.
CREATE OR REPLACE FUNCTION public.pos_payment_session_cancel(p_session_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_session public.pos_payment_sessions%ROWTYPE;
  v_stuck   text;
BEGIN
  SELECT * INTO v_session FROM public.pos_payment_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_cancel: unknown session %', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_session.branch_id);

  IF v_session.status = 'committed' THEN
    RAISE EXCEPTION 'pos_payment_session_cancel: session % already committed', p_session_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_session.status = 'cancelled' THEN
    RETURN;
  END IF;

  -- Cash can be handed back at the drawer, so cancelling reverses it inline.
  -- Captured card / wallet / voucher money can only be undone by the driver:
  -- it must be reversed explicitly through pos_payment_session_reverse_tender
  -- so the reversal is auditable and reaches the processor.
  SELECT string_agg(t.tender_kind || ':' || t.amount::text, ', ')
    INTO v_stuck
    FROM public.pos_payment_session_tenders t
   WHERE t.session_id = p_session_id
     AND t.tender_kind <> 'cash'
     AND t.auth_state NOT IN ('reversed','failed');

  IF v_stuck IS NOT NULL THEN
    RAISE EXCEPTION
      'pos_payment_session_cancel: session % still holds captured non-cash tenders (%)',
      p_session_id, v_stuck
      USING ERRCODE = 'check_violation',
            HINT = 'Reverse each non-cash tender via pos_payment_session_reverse_tender '
                   'before cancelling the session.';
  END IF;

  UPDATE public.pos_payment_session_tenders
     SET auth_state      = 'reversed',
         reversed_at     = now(),
         reversal_reason = COALESCE(reversal_reason, p_reason)
   WHERE session_id = p_session_id
     AND auth_state NOT IN ('reversed','failed');

  UPDATE public.pos_payment_sessions
     SET status        = 'cancelled',
         closed_at     = now(),
         closed_reason = p_reason
   WHERE id = p_session_id;

  PERFORM public._pos_payment_session_emit(
    'pos.payment.session.cancelled',
    (SELECT s FROM public.pos_payment_sessions s WHERE s.id = p_session_id),
    jsonb_build_object('session_id', p_session_id, 'reason', p_reason,
                       'idempotency_key', p_session_id::text || ':cancel')
  );
END $function$;

-- 7.4 Sweeper: only close sessions with no money attached.
CREATE OR REPLACE FUNCTION public.pos_payment_session_sweep_abandoned(p_older_than_minutes integer DEFAULT 30)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id     uuid;
  v_count  int := 0;
  v_cutoff timestamptz := now() - make_interval(mins => GREATEST(p_older_than_minutes, 1));
BEGIN
  FOR v_id IN
    SELECT s.id
      FROM public.pos_payment_sessions s
     WHERE s.status = 'open'
       AND s.created_at < v_cutoff
       AND public.pos_payment_session_allocated(s.id) = 0
     ORDER BY s.created_at
     LIMIT 500
  LOOP
    BEGIN
      PERFORM public.pos_payment_session_cancel(v_id, 'abandoned');
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;
  END LOOP;
  RETURN v_count;
END $function$;

-- 7.5 Re-assert the wave-wide exposure rule for the routines replaced above.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('pos_payment_session_commit','pos_payment_session_cancel',
                         'pos_payment_session_sweep_abandoned')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;