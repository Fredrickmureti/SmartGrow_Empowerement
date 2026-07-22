
-- POS reversal RPCs: enforce assert_manager_override server-side.
-- Backward compatible: extra params default to NULL. When matrix has
-- no row for the action, assert_manager_override returns NULL and the
-- RPC proceeds as before. When a row exists, missing/forged overrides
-- raise ERRCODE 42501 with a machine-tag reason.

-- 1) pos_card_void -----------------------------------------------------------
DROP FUNCTION IF EXISTS public.pos_card_void(uuid, text);

CREATE OR REPLACE FUNCTION public.pos_card_void(
  p_payment_id           uuid,
  p_reason               text  DEFAULT NULL,
  p_manager_override_id  uuid  DEFAULT NULL,
  p_organization_id      uuid  DEFAULT NULL,
  p_business_id          uuid  DEFAULT NULL,
  p_shift_id             uuid  DEFAULT NULL
) RETURNS public.pos_transaction_payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.pos_transaction_payments;
BEGIN
  SELECT * INTO r FROM public.pos_transaction_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
  IF r.auth_state = 'voided' THEN RETURN r; END IF;
  IF r.auth_state <> 'approved' THEN
    RAISE EXCEPTION 'void illegal from state % (only pre-capture voids)', r.auth_state;
  END IF;

  PERFORM public.assert_manager_override(
    'pos_card_void',
    COALESCE(r.amount, 0),
    p_organization_id,
    p_business_id,
    p_shift_id,
    p_manager_override_id,
    'pos_transaction_payments',
    p_payment_id
  );

  UPDATE public.pos_transaction_payments SET
    auth_state = 'voided',
    status     = 'failed',
    reference  = COALESCE(reference,'') ||
                 CASE WHEN p_reason IS NULL THEN '' ELSE ' void:'||p_reason END
  WHERE id = p_payment_id
  RETURNING * INTO r;
  RETURN r;
END $$;

REVOKE ALL ON FUNCTION public.pos_card_void(uuid,text,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_card_void(uuid,text,uuid,uuid,uuid,uuid) TO authenticated, service_role;

-- 2) pos_card_reverse --------------------------------------------------------
DROP FUNCTION IF EXISTS public.pos_card_reverse(uuid, text);

CREATE OR REPLACE FUNCTION public.pos_card_reverse(
  p_payment_id           uuid,
  p_reason               text  DEFAULT NULL,
  p_manager_override_id  uuid  DEFAULT NULL,
  p_organization_id      uuid  DEFAULT NULL,
  p_business_id          uuid  DEFAULT NULL,
  p_shift_id             uuid  DEFAULT NULL
) RETURNS public.pos_transaction_payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.pos_transaction_payments;
BEGIN
  SELECT * INTO r FROM public.pos_transaction_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment % not found', p_payment_id; END IF;
  IF r.auth_state = 'refunded' THEN RETURN r; END IF;
  IF r.auth_state <> 'captured' THEN
    RAISE EXCEPTION 'reverse illegal from state % (needs capture first)', r.auth_state;
  END IF;

  PERFORM public.assert_manager_override(
    'pos_card_reverse',
    COALESCE(r.amount, 0),
    p_organization_id,
    p_business_id,
    p_shift_id,
    p_manager_override_id,
    'pos_transaction_payments',
    p_payment_id
  );

  UPDATE public.pos_transaction_payments SET
    auth_state = 'refunded',
    status     = 'refunded',
    reference  = COALESCE(reference,'') ||
                 CASE WHEN p_reason IS NULL THEN '' ELSE ' reverse:'||p_reason END
  WHERE id = p_payment_id
  RETURNING * INTO r;
  RETURN r;
END $$;

REVOKE ALL ON FUNCTION public.pos_card_reverse(uuid,text,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_card_reverse(uuid,text,uuid,uuid,uuid,uuid) TO authenticated, service_role;

-- 3) pos_payment_session_reverse_tender --------------------------------------
DROP FUNCTION IF EXISTS public.pos_payment_session_reverse_tender(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.pos_payment_session_reverse_tender(
  p_session_id           uuid,
  p_tender_id            uuid,
  p_reason               text,
  p_manager_override_id  uuid  DEFAULT NULL,
  p_organization_id      uuid  DEFAULT NULL,
  p_business_id          uuid  DEFAULT NULL,
  p_shift_id             uuid  DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_session public.pos_payment_sessions%ROWTYPE;
  v_tender  public.pos_payment_session_tenders%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM public.pos_payment_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_reverse_tender: unknown session %', p_session_id
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_pos_caller_branch_access(v_session.branch_id);

  IF v_session.status IN ('committed','cancelled') THEN
    RAISE EXCEPTION 'pos_payment_session_reverse_tender: session % is %', p_session_id, v_session.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_tender
    FROM public.pos_payment_session_tenders
   WHERE id = p_tender_id AND session_id = p_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_payment_session_reverse_tender: unknown tender %', p_tender_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_tender.auth_state = 'reversed' THEN
    RETURN;
  END IF;

  PERFORM public.assert_manager_override(
    'pos_payment_session_reverse_tender',
    COALESCE(v_tender.amount, 0),
    p_organization_id,
    p_business_id,
    p_shift_id,
    p_manager_override_id,
    'pos_payment_session_tenders',
    p_tender_id
  );

  UPDATE public.pos_payment_session_tenders
     SET auth_state      = 'reversed',
         reversed_at     = now(),
         reversal_reason = p_reason
   WHERE id = p_tender_id;

  IF (public.pos_payment_session_allocated(v_session.id)) < (v_session.grand_total + v_session.tip_amount) - 0.0001 THEN
    UPDATE public.pos_payment_sessions SET status = 'open' WHERE id = v_session.id AND status = 'balanced';
  END IF;

  PERFORM public._pos_payment_session_emit(
    'pos.payment.tender.reversed', v_session,
    jsonb_build_object('session_id', v_session.id, 'tender_id', p_tender_id,
                       'reason', p_reason, 'idempotency_key', p_tender_id::text || ':reverse')
  );
END $$;

REVOKE ALL ON FUNCTION public.pos_payment_session_reverse_tender(uuid,uuid,text,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_payment_session_reverse_tender(uuid,uuid,text,uuid,uuid,uuid,uuid) TO authenticated, service_role;

-- 4) pos_return_authorization_transition -------------------------------------
-- The existing function is preserved; we add an override enforcement wrapper
-- by rewriting it with additional optional params. The RPC body-shape depends
-- on the current definition; we call assert_manager_override before the
-- underlying transition. To avoid mismatching the current body we route
-- through a new function name and keep the old one for internal use.

CREATE OR REPLACE FUNCTION public.pos_return_authorization_transition_v2(
  p_authorization_id     uuid,
  p_to_state             text,
  p_reason               text,
  p_manager_override_id  uuid  DEFAULT NULL,
  p_organization_id      uuid  DEFAULT NULL,
  p_business_id          uuid  DEFAULT NULL,
  p_shift_id             uuid  DEFAULT NULL,
  p_amount               numeric DEFAULT 0
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.assert_manager_override(
    'pos_return_authorization_transition:' || p_to_state,
    COALESCE(p_amount, 0),
    p_organization_id,
    p_business_id,
    p_shift_id,
    p_manager_override_id,
    'pos_return_authorizations',
    p_authorization_id
  );
  PERFORM public.pos_return_authorization_transition(p_authorization_id, p_to_state, p_reason);
END $$;

REVOKE ALL ON FUNCTION public.pos_return_authorization_transition_v2(uuid,text,text,uuid,uuid,uuid,uuid,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_return_authorization_transition_v2(uuid,text,text,uuid,uuid,uuid,uuid,numeric) TO authenticated, service_role;
