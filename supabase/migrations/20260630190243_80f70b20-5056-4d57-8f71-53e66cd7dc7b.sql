
ALTER TABLE public.employee_garnishments
  ADD COLUMN IF NOT EXISTS total_accrued numeric NOT NULL DEFAULT 0;

UPDATE public.employee_garnishments
   SET total_accrued = COALESCE(total_paid, 0)
 WHERE total_accrued = 0;

WITH paid AS (
  SELECT pl.garnishment_id, COALESCE(SUM(a.amount),0)::numeric AS s
    FROM public.payroll_remittance_payment_allocations a
    JOIN public.payroll_liabilities pl ON pl.id = a.liability_id
   WHERE pl.garnishment_id IS NOT NULL
   GROUP BY pl.garnishment_id
)
UPDATE public.employee_garnishments g
   SET total_paid = COALESCE(paid.s, 0)
  FROM paid
 WHERE g.id = paid.garnishment_id;

UPDATE public.employee_garnishments g
   SET total_paid = 0
 WHERE NOT EXISTS (
   SELECT 1 FROM public.payroll_liabilities pl
    JOIN public.payroll_remittance_payment_allocations a ON a.liability_id = pl.id
   WHERE pl.garnishment_id = g.id
 );

COMMENT ON COLUMN public.employee_garnishments.total_accrued IS
  'Cumulative amount deducted from payroll runs (accrual). Bumped by compute-payroll.';
COMMENT ON COLUMN public.employee_garnishments.total_paid IS
  'Cumulative amount actually remitted to the payee (cash). Bumped by the apply_garnishment_payment_to_order trigger on payroll_remittance_payment_allocations.';

CREATE TABLE IF NOT EXISTS public.garnishment_carry_forward (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  garnishment_id uuid NOT NULL REFERENCES public.employee_garnishments(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  source_payroll_run_id uuid NOT NULL,
  source_period_end date NOT NULL,
  requested_amount numeric NOT NULL,
  applied_amount numeric NOT NULL,
  shortfall_amount numeric NOT NULL CHECK (shortfall_amount >= 0),
  reason_code text NOT NULL DEFAULT 'disposable_exhausted',
  consumed_by_run_id uuid NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.garnishment_carry_forward TO authenticated;
GRANT ALL    ON public.garnishment_carry_forward TO service_role;

ALTER TABLE public.garnishment_carry_forward ENABLE ROW LEVEL SECURITY;

CREATE POLICY garnishment_carry_forward_read
  ON public.garnishment_carry_forward
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'manager')
    OR EXISTS (
      SELECT 1 FROM public.employees e
       WHERE e.id = garnishment_carry_forward.employee_id
         AND e.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_garn_cf_unconsumed
  ON public.garnishment_carry_forward (garnishment_id)
  WHERE consumed_by_run_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_garn_cf_emp_pending
  ON public.garnishment_carry_forward (employee_id, organization_id)
  WHERE consumed_by_run_id IS NULL;

COMMENT ON TABLE public.garnishment_carry_forward IS
  'Records the shortfall when a payroll run could not satisfy a garnishment in full (disposable income exhausted or floor hit). Consumed by the next eligible run for the same (employee, garnishment).';

INSERT INTO public.payroll_readiness_rules
  (organization_id, pack_id, code, name, description, scope, severity, source,
   reason_code, check_kind, predicate_sql, remediation_label, remediation_link,
   is_active, sort_order)
VALUES
  (NULL, NULL,
   'garnishment.order_expiring',
   'Garnishment order expiring soon',
   'Warns when an active garnishment order''s end_date falls within 30 days.',
   'org', 'warn', 'core',
   'GARNISHMENT_ORDER_EXPIRING', 'sql',
   'SELECT id FROM public.employee_garnishments WHERE organization_id = $1 AND is_active = true AND status IN (''active'',''approved'') AND end_date IS NOT NULL AND end_date <= (CURRENT_DATE + INTERVAL ''30 days'')',
   'Review or renew the order', '/hr/payroll/garnishments',
   true, 410),

  (NULL, NULL,
   'garnishment.balance_inconsistent',
   'Garnishment balance inconsistent',
   'Blocks the run when total_paid exceeds total_owed, or when total_accrued is less than total_paid for an active order.',
   'org', 'block', 'core',
   'GARNISHMENT_BALANCE_INCONSISTENT', 'sql',
   'SELECT id FROM public.employee_garnishments WHERE organization_id = $1 AND is_active = true AND ((total_owed IS NOT NULL AND total_owed > 0 AND total_paid > total_owed) OR (total_accrued < total_paid))',
   'Adjust the order balance', '/hr/payroll/garnishments',
   true, 411),

  (NULL, NULL,
   'garnishment.priority_conflict',
   'Garnishment priority conflict',
   'Warns when two active orders for the same employee share the same priority value; the engine will fall back to creation order.',
   'org', 'warn', 'core',
   'GARNISHMENT_PRIORITY_CONFLICT', 'sql',
   'SELECT MIN(id) AS id FROM public.employee_garnishments WHERE organization_id = $1 AND is_active = true AND status IN (''active'',''approved'') GROUP BY employee_id, priority HAVING COUNT(*) > 1',
   'Renumber order priorities', '/hr/payroll/garnishments',
   true, 412),

  (NULL, NULL,
   'garnishment.remittance_overdue',
   'Garnishment remittance overdue',
   'Warns when a garnishment-backed payroll liability is past its due date and still has outstanding amount greater than zero.',
   'org', 'warn', 'core',
   'GARNISHMENT_REMITTANCE_OVERDUE', 'sql',
   'SELECT id FROM public.payroll_liabilities WHERE organization_id = $1 AND garnishment_id IS NOT NULL AND outstanding_amount > 0 AND due_date < CURRENT_DATE',
   'Run garnishment payment', '/hr/payroll/garnishments',
   true, 413)
ON CONFLICT DO NOTHING;
