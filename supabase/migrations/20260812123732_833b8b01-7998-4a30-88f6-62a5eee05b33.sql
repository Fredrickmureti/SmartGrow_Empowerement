-- ============================================================================
-- Expense + customer refund reversal intent (ADR 0130 Phase 5.5 completion)
--
-- `expense` and `customer_refund` are registered as reversible documents, but
-- `resolve_reversal_intent_finance` had no branch for either, so the intent
-- authority raised "does not know document type". Everything layered on top of
-- the intent authority -- `reversal_approval_requirement`,
-- `preview_reversal_consequences` -- therefore could never run for an expense.
-- Expense voids were executing with no policy gate and no preview.
--
-- Both resolvers are added as their own functions and dispatched from
-- `resolve_reversal_intent`, matching the vendor credit note pattern, so the
-- large finance resolver is left untouched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_reversal_intent_expense(_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  e              public.expenses%ROWTYPE;
  v_status       text;
  v_terminal     boolean;
  v_is_draft     boolean;
  v_posted       boolean;
  v_period_open  boolean := true;
  v_reimbursed   boolean := false;
  v_queued       boolean := false;
  v_bill_id      uuid;
  v_bill_number  text;
  v_blockers     text[] := ARRAY[]::text[];
  v_blocked      text;
  v_allowed      boolean;
  v_ops          jsonb;
BEGIN
  SELECT * INTO e FROM public.expenses WHERE id = _document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found.', _document_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_belongs_to_org(e.organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
  END IF;

  v_status   := e.status::text;
  v_terminal := v_status IN ('voided', 'rejected');
  v_is_draft := v_status IN ('draft', 'submitted');
  v_posted   := v_status IN ('approved', 'paid');

  v_period_open := COALESCE(public.is_period_open(e.business_id, e.expense_date), true);

  -- Settlement route 1: reimbursed to the employee (payroll or direct).
  v_reimbursed := e.reimbursed_at IS NOT NULL OR e.reimbursed_payslip_id IS NOT NULL;

  -- Settlement route 2 (in flight): queued for payroll but not yet paid. This
  -- is the dangerous state -- the payroll engine would still pay it.
  v_queued := COALESCE(e.reimburse_via_payroll, false)
              AND e.reimbursed_payslip_id IS NULL
              AND NOT v_reimbursed;

  SELECT b.id, b.bill_number INTO v_bill_id, v_bill_number
    FROM public.bills b
   WHERE b.source_expense_id = _document_id
     AND b.status <> 'void'
   LIMIT 1;

  IF v_terminal THEN
    v_blockers := v_blockers || 'already_reversed';
  END IF;
  IF NOT v_period_open THEN
    v_blockers := v_blockers || 'period_closed';
  END IF;
  IF v_reimbursed THEN
    v_blockers := v_blockers || 'settled';
  END IF;
  IF v_bill_id IS NOT NULL THEN
    v_blockers := v_blockers || 'billed';
  END IF;
  IF v_queued THEN
    v_blockers := v_blockers || 'queued_for_payroll';
  END IF;

  v_blocked := CASE
    WHEN v_status = 'voided'   THEN 'This expense has already been voided.'
    WHEN v_status = 'rejected' THEN 'This expense was rejected and never posted; there is nothing to reverse.'
    WHEN v_is_draft            THEN 'This expense has not been approved yet — reject or delete it instead.'
    WHEN v_reimbursed          THEN 'This expense has already been reimbursed to the employee; reverse the reimbursement first.'
    WHEN v_bill_id IS NOT NULL THEN 'A vendor bill (' || COALESCE(v_bill_number, 'draft') ||
                                    ') was raised from this expense; void that bill instead.'
    WHEN v_queued              THEN 'This expense is queued for payroll reimbursement. Remove it from the payroll queue first, otherwise the employee is paid for a reversed expense.'
    WHEN NOT v_period_open     THEN 'The accounting period for this expense is closed.'
    ELSE NULL END;

  v_allowed := v_posted AND v_blocked IS NULL;

  v_ops := jsonb_build_array(jsonb_build_object(
    'operation',      'void',
    'allowed',        v_allowed,
    'label',          'Void expense',
    'description',    'Reverses the expense journal entry, removes its analytic distributions and cancels any reimbursement owed.',
    'blocked_reason', v_blocked));

  -- When a supplier bill owns the liability, the legal move is on the bill.
  IF v_bill_id IS NOT NULL THEN
    v_ops := v_ops || jsonb_build_array(jsonb_build_object(
      'operation',      'none',
      'allowed',        false,
      'label',          'Void bill ' || COALESCE(v_bill_number, ''),
      'description',    'The liability moved to a vendor bill when this expense was converted.',
      'blocked_reason', NULL,
      'target_document_type', 'bill',
      'target_document_id',   v_bill_id));
  END IF;

  RETURN jsonb_build_object(
    'document_type',   'expense',
    'document_id',     _document_id,
    'document_number', COALESCE(e.expense_number, _document_id::text),
    'organization_id', e.organization_id,
    'business_id',     e.business_id,
    'status',          v_status,
    'total',           COALESCE(e.amount, 0),
    'amount_settled',  CASE WHEN v_reimbursed THEN COALESCE(e.amount, 0) ELSE 0 END,
    'state', jsonb_build_object(
      'already_reversed',    v_terminal,
      'is_draft',            v_is_draft,
      'is_posted',           v_posted,
      'is_settled',          v_reimbursed,
      'live_payment_count',  CASE WHEN v_reimbursed THEN 1 ELSE 0 END,
      'live_payment_total',  CASE WHEN v_reimbursed THEN COALESCE(e.amount, 0) ELSE 0 END,
      'is_bank_reconciled',  false,
      'period_open',         v_period_open,
      'queued_for_payroll',  v_queued,
      'reimburse_via_payroll', COALESCE(e.reimburse_via_payroll, false),
      'converted_bill_id',   v_bill_id),
    'blockers',    to_jsonb(v_blockers),
    'recommended', CASE WHEN v_allowed THEN 'void' ELSE 'none' END,
    'operations',  v_ops);
END $function$;

-- ---------------------------------------------------------------------------
-- Customer refund. There is no refund reversal writer yet: the money has left
-- the bank and the correction is a fresh receipt. The resolver says so plainly
-- rather than raising "unknown document type" in front of an operator.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_reversal_intent_customer_refund(_document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r              public.customer_refunds%ROWTYPE;
  v_status       text;
  v_terminal     boolean;
  v_posted       boolean;
  v_period_open  boolean := true;
  v_blockers     text[] := ARRAY[]::text[];
  v_blocked      text;
BEGIN
  SELECT * INTO r FROM public.customer_refunds WHERE id = _document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer refund % not found.', _document_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_belongs_to_org(r.organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this document.' USING ERRCODE = '42501';
  END IF;

  v_status      := COALESCE(r.status, 'draft');
  v_terminal    := v_status IN ('voided', 'cancelled') OR r.voided_at IS NOT NULL;
  v_posted      := NOT v_terminal AND r.journal_entry_id IS NOT NULL;
  v_period_open := COALESCE(public.is_period_open(r.business_id, r.refund_date), true);

  IF v_terminal THEN
    v_blockers := v_blockers || 'already_reversed';
  END IF;
  IF NOT v_period_open THEN
    v_blockers := v_blockers || 'period_closed';
  END IF;

  v_blocked := CASE
    WHEN v_terminal        THEN 'This refund has already been voided.'
    WHEN NOT v_period_open THEN 'The accounting period for this refund is closed.'
    ELSE 'A paid refund cannot be voided — record a customer receipt for the money coming back instead.'
  END;

  RETURN jsonb_build_object(
    'document_type',   'customer_refund',
    'document_id',     _document_id,
    'document_number', COALESCE(r.reference, _document_id::text),
    'organization_id', r.organization_id,
    'business_id',     r.business_id,
    'status',          v_status,
    'total',           COALESCE(r.amount, 0),
    'amount_settled',  COALESCE(r.amount, 0),
    'state', jsonb_build_object(
      'already_reversed',   v_terminal,
      'is_draft',           v_status = 'draft',
      'is_posted',          v_posted,
      'is_settled',         true,
      'live_payment_count', 0,
      'live_payment_total', 0,
      'is_bank_reconciled', false,
      'period_open',        v_period_open),
    'blockers',    to_jsonb(v_blockers),
    'recommended', 'none',
    'operations',  jsonb_build_array(jsonb_build_object(
      'operation',      'void',
      'allowed',        false,
      'label',          'Void refund',
      'description',    'Refunds are corrected with a new customer receipt, not by voiding the payment out of the bank.',
      'blocked_reason', v_blocked)));
END $function$;

-- ---------------------------------------------------------------------------
-- Dispatcher
-- ---------------------------------------------------------------------------
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
  ELSIF _document_type = 'vendor_credit_note' THEN
    RETURN public.resolve_reversal_intent_vendor_credit_note(_document_id);
  ELSIF _document_type = 'expense' THEN
    RETURN public.resolve_reversal_intent_expense(_document_id);
  ELSIF _document_type = 'customer_refund' THEN
    RETURN public.resolve_reversal_intent_customer_refund(_document_id);
  ELSE
    RETURN public.resolve_reversal_intent_finance(_document_type, _document_id);
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent_expense(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent_customer_refund(uuid) TO authenticated;