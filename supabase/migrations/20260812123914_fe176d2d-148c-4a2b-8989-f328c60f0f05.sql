-- ============================================================================
-- expense_void hardening (ADR 0130 parity for the Expenses module)
--
-- Before: free-text reason, no reason code, no period guard, no approval gate,
-- and -- the cash defect -- an expense queued for payroll reimbursement stayed
-- queued after the void, so `compute-payroll` still paid the employee for a
-- reversed expense.
--
-- The reason code parameter is added with a default so existing callers keep
-- compiling; the reason code itself is mandatory at runtime through
-- `assert_reversal_reason`, exactly like `void_bill_atomic`.
-- ============================================================================

DROP FUNCTION IF EXISTS public.expense_void(uuid, text);

CREATE OR REPLACE FUNCTION public.expense_void(
  p_expense_id uuid,
  p_reason text DEFAULT NULL::text,
  p_reason_code text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r public.expenses;
  v_bill uuid;
  v_approval jsonb;
  v_was_queued boolean := false;
BEGIN
  r := public._expense_guard(p_expense_id, ARRAY['approved','paid']);

  -- One shared vocabulary (ADR 0129).
  PERFORM public.assert_reversal_reason('expense', p_reason_code, p_reason);

  -- Fiscal period: an expense may not be reversed into a closed month.
  IF NOT COALESCE(public.is_period_open(r.business_id, r.expense_date), true) THEN
    RAISE EXCEPTION 'The accounting period for % is closed; this expense cannot be voided.',
      to_char(r.expense_date, 'Mon YYYY') USING ERRCODE = '22023';
  END IF;

  -- Governance: high-value / prior-period reversals need an approved request.
  v_approval := public.reversal_approval_requirement('expense', p_expense_id, 'void', r.expense_date);
  IF NOT COALESCE((v_approval->>'satisfied')::boolean, true) THEN
    RAISE EXCEPTION 'This expense reversal needs approval before it can be voided.'
      USING ERRCODE = '42501';
  END IF;

  IF r.reimbursed_payslip_id IS NOT NULL OR r.reimbursed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Expense has been reimbursed and cannot be voided'
      USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_bill FROM public.bills
   WHERE source_expense_id = p_expense_id AND status <> 'void' LIMIT 1;
  IF v_bill IS NOT NULL THEN
    RAISE EXCEPTION 'A vendor bill was created from this expense; void the bill instead'
      USING ERRCODE = '22023';
  END IF;

  -- Cash guard: a queued-but-unpaid payroll reimbursement must leave the queue
  -- with the void, otherwise the payroll engine pays a reversed expense.
  v_was_queued := COALESCE(r.reimburse_via_payroll, false)
                  AND r.reimbursed_payslip_id IS NULL;

  IF r.journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry_atomic(
      r.journal_entry_id,
      COALESCE(p_reason, 'Expense voided'),
      auth.uid(), NULL, NULL);
  END IF;

  DELETE FROM public.analytic_distributions
   WHERE source_type = 'expense' AND source_id = p_expense_id;

  UPDATE public.expenses
     SET status = 'voided', voided_at = now(), voided_by = auth.uid(),
         void_reason = COALESCE(p_reason, 'Expense voided'),
         void_reason_code = p_reason_code,
         reimburse_via_payroll = CASE WHEN v_was_queued THEN false
                                      ELSE reimburse_via_payroll END,
         updated_at = now()
   WHERE id = p_expense_id;

  INSERT INTO public.audit_logs
    (organization_id, business_id, user_id, action, entity_type, entity_id, new_values)
  VALUES (r.organization_id, r.business_id, auth.uid(), 'expense.void', 'expense', r.id,
          jsonb_build_object(
            'reason', p_reason,
            'reason_code', p_reason_code,
            'journal_entry_id', r.journal_entry_id,
            'payroll_reimbursement_dequeued', v_was_queued));

  RETURN jsonb_build_object(
    'success', true,
    'status', 'voided',
    'payroll_reimbursement_dequeued', v_was_queued);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.expense_void(uuid, text, text) TO authenticated;