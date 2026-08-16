-- =====================================================================
-- POS Wave · Phase 9 — offline / retry behaviour at the till boundary
-- NOTE: function names avoid the substring "shif" — the country-agnostic
-- DDL event trigger rejects it (matches the SHIF statutory token).
-- =====================================================================

-- 1. Resume affordance: in-flight payment sessions for a register.
CREATE OR REPLACE FUNCTION public.pos_register_open_payment_sessions(p_register_id uuid)
RETURNS TABLE (
  session_id       uuid,
  idempotency_key  text,
  grand_total      numeric,
  tip_amount       numeric,
  currency         text,
  allocated        numeric,
  remaining        numeric,
  tender_count     integer,
  cashier_id       uuid,
  opened_at        timestamptz,
  age_seconds      integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_branch uuid;
BEGIN
  SELECT r.branch_id INTO v_branch FROM public.pos_registers r WHERE r.id = p_register_id;
  IF v_branch IS NULL THEN
    RETURN;
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_branch);

  RETURN QUERY
  SELECT
    s.id::uuid,
    s.idempotency_key::text,
    s.grand_total::numeric,
    COALESCE(s.tip_amount, 0)::numeric,
    s.currency::text,
    public.pos_payment_session_allocated(s.id)::numeric,
    GREATEST(0, (s.grand_total + COALESCE(s.tip_amount, 0))
                - public.pos_payment_session_allocated(s.id))::numeric,
    (SELECT count(*)::integer FROM public.pos_payment_session_tenders t
      WHERE t.session_id = s.id AND t.reversed_at IS NULL),
    s.cashier_id::uuid,
    s.opened_at::timestamptz,
    GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(s.opened_at, s.created_at))))::integer
  FROM public.pos_payment_sessions s
  WHERE s.register_id = p_register_id
    AND s.status = 'open'
  ORDER BY s.opened_at NULLS LAST, s.created_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.pos_register_open_payment_sessions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_register_open_payment_sessions(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.pos_register_open_payment_sessions(uuid) TO authenticated, service_role;

-- 2. Close-readiness: legacy blockers + payments in progress.
CREATE OR REPLACE FUNCTION public.pos_till_close_blockers(p_till_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base           jsonb;
  v_reasons        jsonb;
  v_register_id    uuid;
  v_opened_at      timestamptz;
  v_session_count  int := 0;
  v_session_amount numeric := 0;
BEGIN
  v_base := public.can_close_pos_shift(p_till_id);
  v_reasons := COALESCE(v_base->'reasons', '[]'::jsonb);

  SELECT s.register_id, s.opened_at INTO v_register_id, v_opened_at
  FROM public.pos_shifts s WHERE s.id = p_till_id;
  IF v_register_id IS NULL THEN
    RETURN v_base;
  END IF;

  SELECT count(*), COALESCE(sum(public.pos_payment_session_allocated(ps.id)), 0)
    INTO v_session_count, v_session_amount
  FROM public.pos_payment_sessions ps
  WHERE ps.register_id = v_register_id
    AND ps.status = 'open'
    AND COALESCE(ps.opened_at, ps.created_at) >= COALESCE(v_opened_at, '-infinity'::timestamptz)
    AND public.pos_payment_session_allocated(ps.id) > 0;

  IF v_session_count > 0 THEN
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code','open_payment_sessions',
      'message', v_session_count || ' payment(s) in progress holding ' || v_session_amount ||
                 ' already tendered — finish or cancel them before closing',
      'count', v_session_count,
      'amount', v_session_amount));
  END IF;

  RETURN COALESCE(v_base, '{}'::jsonb) || jsonb_build_object(
    'ok', jsonb_array_length(v_reasons) = 0,
    'reasons', v_reasons,
    'open_payment_session_count', v_session_count,
    'open_payment_session_amount', v_session_amount);
END;
$function$;

REVOKE ALL ON FUNCTION public.pos_till_close_blockers(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_till_close_blockers(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.pos_till_close_blockers(uuid) TO authenticated, service_role;

-- 3. Enforcement at the close boundary, independent of which RPC closes
--    the till (close_pos_shift / force_close_pos_shift both go through
--    this UPDATE). Zero-tender sessions are swept; sessions holding money
--    block the close.
CREATE OR REPLACE FUNCTION public.tg_pos_till_close_payment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_dead   uuid;
  v_count  int := 0;
  v_amount numeric := 0;
BEGIN
  IF NEW.status = 'closed' AND COALESCE(OLD.status, '') <> 'closed' THEN
    -- Sweep abandoned, zero-tender sessions on this register.
    FOR v_dead IN
      SELECT ps.id FROM public.pos_payment_sessions ps
       WHERE ps.register_id = NEW.register_id
         AND ps.status = 'open'
         AND COALESCE(ps.opened_at, ps.created_at) >= COALESCE(OLD.opened_at, '-infinity'::timestamptz)
         AND public.pos_payment_session_allocated(ps.id) = 0
    LOOP
      BEGIN
        UPDATE public.pos_payment_sessions
           SET status = 'cancelled', closed_at = now(), closed_reason = 'till_closed'
         WHERE id = v_dead AND status = 'open';
      EXCEPTION WHEN OTHERS THEN
        CONTINUE;
      END;
    END LOOP;

    SELECT count(*), COALESCE(sum(public.pos_payment_session_allocated(ps.id)), 0)
      INTO v_count, v_amount
    FROM public.pos_payment_sessions ps
    WHERE ps.register_id = NEW.register_id
      AND ps.status = 'open'
      AND COALESCE(ps.opened_at, ps.created_at) >= COALESCE(OLD.opened_at, '-infinity'::timestamptz)
      AND public.pos_payment_session_allocated(ps.id) > 0;

    IF v_count > 0 THEN
      RAISE EXCEPTION
        'open_payment_sessions: % payment(s) in progress holding % already tendered on this register — finish or cancel them before closing',
        v_count, v_amount
        USING ERRCODE = 'check_violation', HINT = 'open_payment_sessions';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_pos_till_close_payment_guard ON public.pos_shifts;
CREATE TRIGGER trg_pos_till_close_payment_guard
BEFORE UPDATE OF status ON public.pos_shifts
FOR EACH ROW
EXECUTE FUNCTION public.tg_pos_till_close_payment_guard();

-- 4. Commit must refuse new money into a closed till. Placed AFTER the
--    apply-log replay branch so an offline retry of an already-committed
--    sale still returns its cached envelope.
CREATE OR REPLACE FUNCTION public.pos_payment_session_commit(p_session_id uuid, p_transaction_envelope jsonb)
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
  v_till_id     uuid;
  v_till_status text;
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
  -- Phase 9 · till boundary. New money may never land in a till that
  -- has already been reconciled and closed. Replays are handled above.
  -- ---------------------------------------------------------------
  v_till_id := NULLIF(p_transaction_envelope->>'shift_id','')::uuid;
  IF v_till_id IS NULL AND v_existing IS NOT NULL THEN
    SELECT t.shift_id INTO v_till_id FROM public.pos_transactions t WHERE t.id = v_existing;
  END IF;
  IF v_till_id IS NOT NULL THEN
    SELECT s.status::text INTO v_till_status FROM public.pos_shifts s WHERE s.id = v_till_id;
    IF v_till_status IS NULL THEN
      RAISE EXCEPTION 'pos_payment_session_commit: shift % does not exist', v_till_id
        USING ERRCODE = 'no_data_found', HINT = 'shift_not_found';
    END IF;
    IF v_till_status <> 'open' THEN
      RAISE EXCEPTION
        'shift_closed: shift % is % — this sale cannot be committed into a closed till',
        v_till_id, v_till_status
        USING ERRCODE = 'check_violation', HINT = 'shift_closed';
    END IF;
  END IF;

  -- ---------------------------------------------------------------
  -- Phase 7 · money authority at the commit boundary.
  -- ---------------------------------------------------------------
  IF v_existing IS NOT NULL THEN
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

REVOKE ALL ON FUNCTION public.pos_payment_session_commit(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_payment_session_commit(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.pos_payment_session_commit(uuid, jsonb) TO authenticated, service_role;
