
-- ───────── 1. Garnishments ─────────
DO $$ BEGIN
  CREATE TYPE public.garnishment_kind AS ENUM (
    'child_support', 'tax_levy', 'court_order', 'student_loan',
    'creditor', 'wage_assignment', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.garnishment_cap_rule AS ENUM (
    'fixed_amount',          -- always deduct fixed_amount
    'percent_disposable',    -- deduct percent_of_disposable * disposable_earnings
    'lesser_of_fixed_or_pct' -- min(fixed_amount, pct * disposable)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.employee_garnishments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  kind public.garnishment_kind NOT NULL,
  priority smallint NOT NULL DEFAULT 100, -- lower runs first
  case_reference text,
  issuing_authority text,
  cap_rule public.garnishment_cap_rule NOT NULL DEFAULT 'fixed_amount',
  fixed_amount numeric(18,2),
  percent_of_disposable numeric(6,4), -- e.g. 0.25 = 25%
  total_owed numeric(18,2),
  total_paid numeric(18,2) NOT NULL DEFAULT 0,
  start_date date NOT NULL,
  end_date date,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_garnishments_amount_chk CHECK (
    (cap_rule = 'fixed_amount' AND fixed_amount IS NOT NULL)
    OR (cap_rule = 'percent_disposable' AND percent_of_disposable IS NOT NULL)
    OR (cap_rule = 'lesser_of_fixed_or_pct'
        AND fixed_amount IS NOT NULL AND percent_of_disposable IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS employee_garnishments_employee_idx
  ON public.employee_garnishments(employee_id, is_active, priority);
CREATE INDEX IF NOT EXISTS employee_garnishments_org_idx
  ON public.employee_garnishments(organization_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_garnishments TO authenticated;
GRANT ALL ON public.employee_garnishments TO service_role;

ALTER TABLE public.employee_garnishments ENABLE ROW LEVEL SECURITY;

CREATE POLICY employee_garnishments_org_read
  ON public.employee_garnishments FOR SELECT
  TO authenticated
  USING (organization_id IN (
    SELECT uba.organization_id
      FROM public.user_business_access uba
     WHERE uba.user_id = auth.uid()
  ));

CREATE POLICY employee_garnishments_hr_write
  ON public.employee_garnishments FOR ALL
  TO authenticated
  USING (
    organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba
       WHERE uba.user_id = auth.uid()
    )
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'hr_admin')
      OR public.has_role(auth.uid(), 'payroll_admin')
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba
       WHERE uba.user_id = auth.uid()
    )
    AND (
      public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'hr_admin')
      OR public.has_role(auth.uid(), 'payroll_admin')
    )
  );

CREATE TRIGGER trg_employee_garnishments_updated_at
  BEFORE UPDATE ON public.employee_garnishments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ───────── 2. Expense → payroll reimbursement ─────────
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reimburse_via_payroll boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reimbursed_payslip_id uuid REFERENCES public.payslips(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reimbursed_run_id uuid REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reimbursed_at timestamptz;

CREATE INDEX IF NOT EXISTS expenses_employee_reimburse_idx
  ON public.expenses(employee_id, reimburse_via_payroll)
  WHERE reimburse_via_payroll = true AND reimbursed_payslip_id IS NULL;
