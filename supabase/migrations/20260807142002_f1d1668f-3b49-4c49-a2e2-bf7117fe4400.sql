-- ============================================================================
-- ADR 0129 Phase 5.5 — POS and payroll reversal parity.
--
-- 1. resolve_reversal_intent becomes a thin dispatcher. The finance body is
--    renamed (not retyped) to resolve_reversal_intent_finance; POS and payroll
--    get their own module resolvers returning the identical jsonb shape.
-- 2. The reversal reason vocabulary gains pos_transaction / payroll_run codes.
-- 3. Both modules are gated by assert_can_reverse through BEFORE UPDATE
--    triggers on the terminal status flip, so the gate cannot be bypassed by a
--    writer that forgets to call it.
-- ============================================================================

ALTER FUNCTION public.resolve_reversal_intent(text, uuid)
  RENAME TO resolve_reversal_intent_finance;

-- ------------------------------------------------------------------ POS
CREATE OR REPLACE FUNCTION public.resolve_reversal_intent_pos(_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tx          public.pos_transactions%ROWTYPE;
  v_number      text;
  v_status      text;
  v_terminal    boolean := false;
  v_posted      boolean := false;
  v_returns     int := 0;
  v_shift_open  boolean := false;
  v_period_open boolean := true;
  v_ops         jsonb;
  v_recommended text;
  v_blockers    text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_tx FROM public.pos_transactions WHERE id = _document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS transaction % not found.', _document_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_belongs_to_org(v_tx.organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
  END IF;

  v_number   := COALESCE(v_tx.transaction_number, _document_id::text);
  v_status   := COALESCE(v_tx.status, 'draft');
  v_terminal := v_status IN ('voided', 'cancelled', 'reversed');
  v_posted   := v_status = 'completed';

  SELECT count(*) INTO v_returns
    FROM public.pos_transactions r
   WHERE r.original_transaction_id = _document_id
     AND r.transaction_type = 'return'
     AND COALESCE(r.status, 'completed') <> 'voided';

  SELECT COALESCE(s.status, '') = 'open' INTO v_shift_open
    FROM public.pos_shifts s WHERE s.id = v_tx.shift_id;
  v_shift_open := COALESCE(v_shift_open, false);

  IF v_tx.business_id IS NOT NULL THEN
    v_period_open := public.is_period_open(v_tx.business_id, CURRENT_DATE);
  END IF;

  IF v_terminal THEN v_blockers := v_blockers || 'already_reversed'::text; END IF;
  IF v_returns > 0 THEN v_blockers := v_blockers || 'returned'::text; END IF;
  IF NOT v_shift_open THEN v_blockers := v_blockers || 'shift_closed'::text; END IF;
  IF NOT v_period_open THEN v_blockers := v_blockers || 'period_closed'::text; END IF;

  IF v_terminal THEN
    v_recommended := 'none';
    v_ops := jsonb_build_array(jsonb_build_object(
      'operation', 'none', 'allowed', false,
      'label', 'Nothing to reverse',
      'blocked_reason', 'This sale is already ' || v_status || '.'));
  ELSE
    v_ops := jsonb_build_array(
      jsonb_build_object(
        'operation', 'void',
        'allowed', v_posted AND v_returns = 0 AND v_shift_open AND v_period_open,
        'label', 'Void the sale',
        'description', 'Cancels the sale inside the same open shift, puts the stock back and reverses the posting.',
        'blocked_reason', CASE
          WHEN NOT v_posted THEN 'Only a completed sale can be voided (status: ' || v_status || ').'
          WHEN v_returns > 0 THEN 'A return has already been processed against this sale. Refund or return the remaining goods instead.'
          WHEN NOT v_shift_open THEN 'The shift covering this sale is closed. Process a refund or a goods return instead.'
          WHEN NOT v_period_open THEN 'The current accounting period is closed.'
          ELSE NULL END),
      jsonb_build_object(
        'operation', 'refund_sale',
        'allowed', v_posted AND v_period_open,
        'label', 'Refund the customer',
        'description', 'Returns the money to the customer and keeps the original sale as history. The correct move once the shift is closed.',
        'blocked_reason', CASE
          WHEN NOT v_posted THEN 'Only a completed sale can be refunded.'
          WHEN NOT v_period_open THEN 'The current accounting period is closed.'
          ELSE NULL END),
      jsonb_build_object(
        'operation', 'return_goods',
        'allowed', v_posted AND v_period_open,
        'label', 'Take the goods back',
        'description', 'Records a return against the sale, puts the goods back into stock and settles the value with the customer.',
        'blocked_reason', CASE
          WHEN NOT v_posted THEN 'Only a completed sale can be returned.'
          WHEN NOT v_period_open THEN 'The current accounting period is closed.'
          ELSE NULL END));

    v_recommended := CASE
      WHEN v_posted AND v_returns = 0 AND v_shift_open AND v_period_open THEN 'void'
      WHEN v_posted THEN 'refund_sale'
      ELSE 'none' END;
  END IF;

  RETURN jsonb_build_object(
    'document_type',   'pos_transaction',
    'document_id',     _document_id,
    'document_number', v_number,
    'status',          v_status,
    'organization_id', v_tx.organization_id,
    'business_id',     v_tx.business_id,
    'total',           COALESCE(v_tx.total, 0),
    'amount_settled',  COALESCE(v_tx.total, 0),
    'state', jsonb_build_object(
      'already_reversed',   v_terminal,
      'is_draft',           NOT v_posted AND NOT v_terminal,
      'is_posted',          v_posted,
      'is_settled',         v_returns > 0,
      'live_payment_count', v_returns,
      'live_payment_total', 0,
      'is_bank_reconciled', false,
      'shift_open',         v_shift_open,
      'period_open',        v_period_open),
    'blockers',    to_jsonb(v_blockers),
    'recommended', v_recommended,
    'operations',  v_ops);
END;
$function$;

-- -------------------------------------------------------------- payroll
CREATE OR REPLACE FUNCTION public.resolve_reversal_intent_payroll(_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r             public.payroll_runs%ROWTYPE;
  v_number      text;
  v_status      text;
  v_terminal    boolean := false;
  v_posted      boolean := false;
  v_is_draft    boolean := false;
  v_is_reversal boolean := false;
  v_period_open boolean := true;
  v_ops         jsonb;
  v_recommended text;
  v_blockers    text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO r FROM public.payroll_runs WHERE id = _document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payroll run % not found.', _document_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_belongs_to_org(r.organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
  END IF;

  v_number      := COALESCE(r.payroll_number, _document_id::text);
  v_status      := COALESCE(r.status, 'draft');
  v_is_reversal := COALESCE(r.is_reversal, false);
  v_terminal    := v_status = 'reversed' OR r.reversed_at IS NOT NULL;
  v_posted      := v_status IN ('posted', 'paid') AND NOT v_terminal;
  v_is_draft    := NOT v_posted AND NOT v_terminal;

  IF r.business_id IS NOT NULL THEN
    v_period_open := public.is_period_open(r.business_id, CURRENT_DATE);
  END IF;

  IF v_terminal THEN v_blockers := v_blockers || 'already_reversed'::text; END IF;
  IF v_is_reversal THEN v_blockers := v_blockers || 'is_reversal_run'::text; END IF;
  IF NOT v_period_open THEN v_blockers := v_blockers || 'period_closed'::text; END IF;

  IF v_terminal OR v_is_reversal THEN
    v_recommended := 'none';
    v_ops := jsonb_build_array(jsonb_build_object(
      'operation', 'none', 'allowed', false,
      'label', 'Nothing to reverse',
      'blocked_reason', CASE
        WHEN v_is_reversal THEN 'This run is itself a reversal of an earlier payroll.'
        ELSE 'This payroll run is already reversed.' END));
  ELSE
    v_ops := jsonb_build_array(
      jsonb_build_object(
        'operation', 'reverse_run',
        'allowed', v_posted AND v_period_open,
        'label', 'Reverse the payroll run',
        'description', 'Creates a mirror-image payroll run that cancels every payslip and reverses the postings. The original stays on record.',
        'blocked_reason', CASE
          WHEN v_is_draft THEN 'This run has not been posted or paid yet (status: ' || v_status || '). Edit or delete it instead.'
          WHEN NOT v_period_open THEN 'The current accounting period is closed. Reverse it in an open period, or run a correction payroll instead.'
          ELSE NULL END),
      jsonb_build_object(
        'operation', 'correction_run',
        'allowed', v_posted,
        'label', 'Run a correction payroll',
        'description', 'Pays or recovers only the difference, leaving the original run intact. The right move when most of the payroll was correct.',
        'blocked_reason', CASE WHEN v_is_draft
          THEN 'Nothing has been posted yet, so there is nothing to correct.' ELSE NULL END));

    v_recommended := CASE
      WHEN v_posted AND v_period_open THEN 'reverse_run'
      WHEN v_posted THEN 'correction_run'
      ELSE 'none' END;
  END IF;

  RETURN jsonb_build_object(
    'document_type',   'payroll_run',
    'document_id',     _document_id,
    'document_number', v_number,
    'status',          v_status,
    'organization_id', r.organization_id,
    'business_id',     r.business_id,
    'total',           COALESCE(r.total_gross, 0),
    'amount_settled',  COALESCE(r.total_net, 0),
    'state', jsonb_build_object(
      'already_reversed',   v_terminal,
      'is_draft',           v_is_draft,
      'is_posted',          v_posted,
      'is_settled',         v_status = 'paid',
      'live_payment_count', 0,
      'live_payment_total', 0,
      'is_bank_reconciled', false,
      'is_reversal_run',    v_is_reversal,
      'period_open',        v_period_open),
    'blockers',    to_jsonb(v_blockers),
    'recommended', v_recommended,
    'operations',  v_ops);
END;
$function$;

-- ------------------------------------------------------------ dispatcher
CREATE OR REPLACE FUNCTION public.resolve_reversal_intent(_document_type text, _document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF _document_id IS NULL THEN
    RAISE EXCEPTION 'resolve_reversal_intent requires a document id' USING ERRCODE = '22023';
  END IF;

  IF _document_type = 'pos_transaction' THEN
    RETURN public.resolve_reversal_intent_pos(_document_id);
  ELSIF _document_type = 'payroll_run' THEN
    RETURN public.resolve_reversal_intent_payroll(_document_id);
  ELSE
    RETURN public.resolve_reversal_intent_finance(_document_type, _document_id);
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_reversal_intent_finance(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_reversal_intent_pos(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_reversal_intent_payroll(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent_finance(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent_pos(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent_payroll(uuid) TO authenticated;

-- ============================================================ vocabulary
UPDATE public.reversal_reason_codes
   SET applies_to = (
         SELECT ARRAY(SELECT DISTINCT unnest(applies_to || ARRAY['pos_transaction','payroll_run']))
       )
 WHERE code IN ('data_entry_error', 'other', 'test_transaction', 'wrong_amount');

UPDATE public.reversal_reason_codes
   SET applies_to = (
         SELECT ARRAY(SELECT DISTINCT unnest(applies_to || ARRAY['pos_transaction']))
       )
 WHERE code IN ('duplicate_document', 'pricing_error', 'order_cancelled');

INSERT INTO public.reversal_reason_codes (code, label, description, applies_to, requires_comment, sort_order, active)
VALUES
  ('pos_wrong_item_scanned', 'Wrong item scanned',
   'The wrong product went through the till and the sale must be unwound.',
   ARRAY['pos_transaction'], false, 210, true),
  ('pos_customer_cancelled', 'Customer changed their mind',
   'The customer abandoned the purchase after it was completed.',
   ARRAY['pos_transaction'], false, 220, true),
  ('pos_tender_error', 'Wrong tender taken',
   'The sale was settled with the wrong payment method or tender amount.',
   ARRAY['pos_transaction'], true, 230, true),
  ('pos_training_transaction', 'Training or test sale',
   'The sale was rung up while training and is not a real transaction.',
   ARRAY['pos_transaction'], false, 240, true),
  ('payroll_wrong_period', 'Wrong pay period',
   'The payroll was run against the wrong pay period.',
   ARRAY['payroll_run'], false, 310, true),
  ('payroll_incorrect_earnings', 'Incorrect earnings or deductions',
   'Earnings, deductions or contributions were wrong for one or more employees.',
   ARRAY['payroll_run'], true, 320, true),
  ('payroll_duplicate_run', 'Duplicate payroll run',
   'The same pay period was processed twice.',
   ARRAY['payroll_run'], false, 330, true),
  ('payroll_wrong_employee_set', 'Wrong employees included',
   'The run covered the wrong group of employees.',
   ARRAY['payroll_run'], true, 340, true)
ON CONFLICT (code) DO NOTHING;

-- ======================================================== enforcement gate
-- POS: the void writer (process_pos_void) runs its own operational checks, but
-- the canonical authorization / period / approval gate is enforced here so no
-- writer, job or backfill can flip a sale to voided around it.
CREATE OR REPLACE FUNCTION public._pos_transaction_reversal_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'voided' AND COALESCE(OLD.status, '') <> 'voided'
     AND COALESCE(OLD.status, '') = 'completed' THEN
    PERFORM public.assert_can_reverse(
      'pos_transaction', OLD.id, 'void', NEW.voided_by, CURRENT_DATE);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_pos_transaction_reversal_gate ON public.pos_transactions;
CREATE TRIGGER trg_pos_transaction_reversal_gate
  BEFORE UPDATE OF status ON public.pos_transactions
  FOR EACH ROW EXECUTE FUNCTION public._pos_transaction_reversal_gate();

-- Payroll: same gate on the terminal flip performed by
-- payroll_reverse_run_atomic.
CREATE OR REPLACE FUNCTION public._payroll_run_reversal_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'reversed' AND COALESCE(OLD.status, '') <> 'reversed' THEN
    PERFORM public.assert_can_reverse(
      'payroll_run', OLD.id, 'reverse_run', NEW.reversed_by, CURRENT_DATE);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_payroll_run_reversal_gate ON public.payroll_runs;
CREATE TRIGGER trg_payroll_run_reversal_gate
  BEFORE UPDATE OF status ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public._payroll_run_reversal_gate();