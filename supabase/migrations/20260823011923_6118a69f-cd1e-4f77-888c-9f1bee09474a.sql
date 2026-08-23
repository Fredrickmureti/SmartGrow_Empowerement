-- Void must reverse, never delete: history stays, the axis nets to zero.
CREATE OR REPLACE FUNCTION public.expense_void(p_expense_id uuid, p_reason text DEFAULT NULL::text, p_reason_code text DEFAULT NULL::text)
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

  PERFORM public.assert_reversal_reason('expense', p_reason_code, p_reason);

  IF NOT COALESCE(public.is_period_open(r.business_id, r.expense_date), true) THEN
    RAISE EXCEPTION 'The accounting period for % is closed; this expense cannot be voided.',
      to_char(r.expense_date, 'Mon YYYY') USING ERRCODE = '22023';
  END IF;

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

  v_was_queued := COALESCE(r.reimburse_via_payroll, false)
                  AND r.reimbursed_payslip_id IS NULL;

  -- The reversing entry mirrors the analytic value of every original line,
  -- which produces the contra allocation. Nothing is deleted.
  IF r.journal_entry_id IS NOT NULL THEN
    PERFORM public.void_journal_entry_atomic(
      r.journal_entry_id,
      COALESCE(p_reason, 'Expense voided'),
      auth.uid(), NULL, NULL);
  END IF;

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

-- ---------------------------------------------------------------------
-- analytic_distributions becomes a projection of the ledger. The table
-- held no rows, so nothing is lost, and it can no longer drift.
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS public.analytic_distributions;

CREATE VIEW public.analytic_distributions
WITH (security_invoker = true)
AS
SELECT
  a.id,
  a.organization_id,
  a.business_id,
  a.branch_id,
  a.analytic_account_id,
  a.plan_id,
  COALESCE(je.source_type, 'journal_entry') AS source_type,
  COALESCE(je.source_id, a.journal_entry_id) AS source_id,
  a.journal_entry_id,
  a.journal_entry_line_id,
  a.amount,
  a.percentage,
  a.entry_date AS date,
  a.description,
  a.created_at
FROM public.journal_entry_line_analytics a
JOIN public.journal_entries je ON je.id = a.journal_entry_id
WHERE je.status <> 'void';

GRANT SELECT ON public.analytic_distributions TO authenticated;
GRANT ALL ON public.analytic_distributions TO service_role;

-- ---------------------------------------------------------------------
-- Analytic balances are a period question, so the report demands a range.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.analytic_balances(
  p_business_id uuid,
  p_date_from date,
  p_date_to date,
  p_plan_id uuid DEFAULT NULL
)
RETURNS TABLE (
  analytic_account_id uuid,
  code text,
  name text,
  plan_id uuid,
  plan_name text,
  debit numeric,
  credit numeric,
  net numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT aa.id,
         aa.code,
         aa.name,
         ap.id,
         ap.name,
         COALESCE(SUM(a.amount) FILTER (WHERE a.amount > 0), 0),
         COALESCE(-SUM(a.amount) FILTER (WHERE a.amount < 0), 0),
         COALESCE(SUM(a.amount), 0)
    FROM public.analytic_accounts aa
    JOIN public.analytic_plans ap ON ap.id = aa.plan_id
    LEFT JOIN public.journal_entry_line_analytics a
           ON a.analytic_account_id = aa.id
          AND a.entry_date BETWEEN p_date_from AND p_date_to
          AND EXISTS (SELECT 1 FROM public.journal_entries je
                       WHERE je.id = a.journal_entry_id AND je.status <> 'void')
   WHERE aa.business_id = p_business_id
     AND (p_plan_id IS NULL OR aa.plan_id = p_plan_id)
     AND public.user_can_access_business(auth.uid(), p_business_id)
     AND public.user_has_module_permission(auth.uid(), aa.organization_id, aa.business_id, 'financials', 'read')
   GROUP BY aa.id, aa.code, aa.name, ap.id, ap.name
   ORDER BY ap.name, aa.code NULLS LAST, aa.name;
$$;

REVOKE ALL ON FUNCTION public.analytic_balances(uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.analytic_balances(uuid, date, date, uuid) TO authenticated, service_role;