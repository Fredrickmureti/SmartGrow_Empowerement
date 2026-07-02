
-- Enums
DO $$ BEGIN
  CREATE TYPE public.payslip_line_category AS ENUM (
    'earning','deduction','employer_contribution',
    'statutory_employee','statutory_employer',
    'reimbursement','benefit','loan_repayment','net'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.payslip_input_source AS ENUM (
    'attendance','leave','timesheet','manual','contract','work_entry'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.payment_batch_status AS ENUM (
    'draft','pending','confirmed','partially_paid','paid','cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.payroll_run_issue_severity AS ENUM ('info','warning','blocker');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

-- pay_schedules
CREATE TABLE IF NOT EXISTS public.pay_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','semimonthly','monthly','quarterly','annual')),
  cutoff_offset_days INTEGER NOT NULL DEFAULT 0,
  payment_offset_days INTEGER NOT NULL DEFAULT 0,
  anchor_day INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, name)
);
CREATE INDEX IF NOT EXISTS idx_pay_schedules_business ON public.pay_schedules(business_id);
ALTER TABLE public.pay_schedules ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_pay_schedules_updated_at ON public.pay_schedules;
CREATE TRIGGER trg_pay_schedules_updated_at BEFORE UPDATE ON public.pay_schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- payslip_lines
CREATE TABLE IF NOT EXISTS public.payslip_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  payslip_id UUID NOT NULL REFERENCES public.payslips(id) ON DELETE CASCADE,
  payroll_run_id UUID,
  employee_id UUID,
  rule_code TEXT NOT NULL,
  rule_type TEXT,
  category public.payslip_line_category NOT NULL,
  label TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  employee_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  employer_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  taxable BOOLEAN NOT NULL DEFAULT FALSE,
  rule_version_id UUID,
  rule_version_hash TEXT,
  source JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payslip_lines_payslip ON public.payslip_lines(payslip_id, sequence);
CREATE INDEX IF NOT EXISTS idx_payslip_lines_run ON public.payslip_lines(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payslip_lines_rule ON public.payslip_lines(business_id, rule_code);
ALTER TABLE public.payslip_lines ENABLE ROW LEVEL SECURITY;

-- payslip_inputs
CREATE TABLE IF NOT EXISTS public.payslip_inputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  payslip_id UUID NOT NULL REFERENCES public.payslips(id) ON DELETE CASCADE,
  payroll_run_id UUID,
  employee_id UUID,
  source public.payslip_input_source NOT NULL,
  reference_id UUID,
  label TEXT,
  quantity NUMERIC(18,4),
  uom TEXT,
  amount NUMERIC(18,4),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payslip_inputs_payslip ON public.payslip_inputs(payslip_id);
CREATE INDEX IF NOT EXISTS idx_payslip_inputs_run ON public.payslip_inputs(payroll_run_id);
ALTER TABLE public.payslip_inputs ENABLE ROW LEVEL SECURITY;

-- contract_compensation_components
CREATE TABLE IF NOT EXISTS public.contract_compensation_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  contract_id UUID NOT NULL REFERENCES public.employee_contracts(id) ON DELETE CASCADE,
  component_code TEXT NOT NULL,
  label TEXT,
  amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  recurrence TEXT NOT NULL DEFAULT 'monthly' CHECK (recurrence IN ('monthly','one_off','per_period')),
  taxable BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from DATE,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contract_id, component_code, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_ccc_contract ON public.contract_compensation_components(contract_id);
ALTER TABLE public.contract_compensation_components ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_ccc_updated_at ON public.contract_compensation_components;
CREATE TRIGGER trg_ccc_updated_at BEFORE UPDATE ON public.contract_compensation_components
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- payroll_payment_batches
CREATE TABLE IF NOT EXISTS public.payroll_payment_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  payroll_run_id UUID NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  batch_number TEXT NOT NULL,
  status public.payment_batch_status NOT NULL DEFAULT 'draft',
  bank_account_id UUID,
  payment_date DATE,
  total_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  reference TEXT,
  notes TEXT,
  created_by UUID,
  confirmed_by UUID,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, batch_number)
);
CREATE INDEX IF NOT EXISTS idx_ppb_run ON public.payroll_payment_batches(payroll_run_id);
ALTER TABLE public.payroll_payment_batches ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_ppb_updated_at ON public.payroll_payment_batches;
CREATE TRIGGER trg_ppb_updated_at BEFORE UPDATE ON public.payroll_payment_batches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.payroll_payment_batch_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  batch_id UUID NOT NULL REFERENCES public.payroll_payment_batches(id) ON DELETE CASCADE,
  payslip_id UUID NOT NULL REFERENCES public.payslips(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL,
  amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  status public.payment_batch_status NOT NULL DEFAULT 'draft',
  paid_at TIMESTAMPTZ,
  payment_reference TEXT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, payslip_id)
);
CREATE INDEX IF NOT EXISTS idx_ppbi_batch ON public.payroll_payment_batch_items(batch_id);
ALTER TABLE public.payroll_payment_batch_items ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS trg_ppbi_updated_at ON public.payroll_payment_batch_items;
CREATE TRIGGER trg_ppbi_updated_at BEFORE UPDATE ON public.payroll_payment_batch_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- payroll_run_issues
CREATE TABLE IF NOT EXISTS public.payroll_run_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  payroll_run_id UUID NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  employee_id UUID,
  code TEXT NOT NULL,
  severity public.payroll_run_issue_severity NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  details JSONB,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pri_run ON public.payroll_run_issues(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_pri_employee ON public.payroll_run_issues(employee_id);
ALTER TABLE public.payroll_run_issues ENABLE ROW LEVEL SECURITY;

-- RLS using project's existing helpers (mirrors payslips/payroll_runs pattern)
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'pay_schedules','payslip_lines','payslip_inputs',
    'contract_compensation_components','payroll_payment_batches',
    'payroll_payment_batch_items','payroll_run_issues'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format($f$
      DROP POLICY IF EXISTS "%1$s_select" ON public.%1$I;
      CREATE POLICY "%1$s_select" ON public.%1$I FOR SELECT
        USING (
          business_id IS NOT NULL
          AND public.user_can_access_business(auth.uid(), business_id)
          AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read')
        );
      DROP POLICY IF EXISTS "%1$s_insert" ON public.%1$I;
      CREATE POLICY "%1$s_insert" ON public.%1$I FOR INSERT
        WITH CHECK (
          business_id IS NOT NULL
          AND public.user_can_access_business(auth.uid(), business_id)
          AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
        );
      DROP POLICY IF EXISTS "%1$s_update" ON public.%1$I;
      CREATE POLICY "%1$s_update" ON public.%1$I FOR UPDATE
        USING (
          business_id IS NOT NULL
          AND public.user_can_access_business(auth.uid(), business_id)
          AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
        );
      DROP POLICY IF EXISTS "%1$s_delete" ON public.%1$I;
      CREATE POLICY "%1$s_delete" ON public.%1$I FOR DELETE
        USING (
          business_id IS NOT NULL
          AND public.user_can_access_business(auth.uid(), business_id)
          AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'delete')
        );
    $f$, t);
  END LOOP;
END $$;

-- Portal employee self-read on payslip_lines + payslip_inputs
DROP POLICY IF EXISTS "payslip_lines_self_select" ON public.payslip_lines;
CREATE POLICY "payslip_lines_self_select" ON public.payslip_lines FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.payslips p
    JOIN public.employees e ON e.id = p.employee_id
    WHERE p.id = payslip_lines.payslip_id
      AND e.user_id = auth.uid()
      AND p.status IN ('approved','posted','paid')
  ));

DROP POLICY IF EXISTS "payslip_inputs_self_select" ON public.payslip_inputs;
CREATE POLICY "payslip_inputs_self_select" ON public.payslip_inputs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.payslips p
    JOIN public.employees e ON e.id = p.employee_id
    WHERE p.id = payslip_inputs.payslip_id
      AND e.user_id = auth.uid()
      AND p.status IN ('approved','posted','paid')
  ));

-- ============================================================
-- BACKFILL: synthesise payslip_lines from legacy columns
-- (idempotent — skipped where lines already exist)
-- ============================================================
INSERT INTO public.payslip_lines
  (organization_id, business_id, payslip_id, payroll_run_id, employee_id,
   rule_code, rule_type, category, label, sequence,
   employee_amount, employer_amount, taxable, source)
SELECT * FROM (
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'BASIC'::TEXT, 'earning'::TEXT, 'earning'::public.payslip_line_category,
         'Basic Salary'::TEXT, 10, COALESCE(p.basic_salary,0), 0::NUMERIC, TRUE,
         jsonb_build_object('backfill', true, 'from','basic_salary')
  FROM public.payslips p WHERE COALESCE(p.basic_salary,0) <> 0
  UNION ALL
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'HOUSING', 'earning', 'earning'::public.payslip_line_category,
         'Housing Allowance', 20, COALESCE(p.housing_allowance,0), 0, TRUE,
         jsonb_build_object('backfill', true, 'from','housing_allowance')
  FROM public.payslips p WHERE COALESCE(p.housing_allowance,0) <> 0
  UNION ALL
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'TRANSPORT', 'earning', 'earning'::public.payslip_line_category,
         'Transport Allowance', 30, COALESCE(p.transport_allowance,0), 0, TRUE,
         jsonb_build_object('backfill', true, 'from','transport_allowance')
  FROM public.payslips p WHERE COALESCE(p.transport_allowance,0) <> 0
  UNION ALL
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'OVERTIME', 'earning', 'earning'::public.payslip_line_category,
         'Overtime', 40, COALESCE(p.overtime_pay,0), 0, TRUE,
         jsonb_build_object('backfill', true, 'from','overtime_pay')
  FROM public.payslips p WHERE COALESCE(p.overtime_pay,0) <> 0
  UNION ALL
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'BONUS', 'earning', 'earning'::public.payslip_line_category,
         'Bonus', 50, COALESCE(p.bonus,0), 0, TRUE,
         jsonb_build_object('backfill', true, 'from','bonus')
  FROM public.payslips p WHERE COALESCE(p.bonus,0) <> 0
  UNION ALL
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'PAYE', 'statutory', 'statutory_employee'::public.payslip_line_category,
         'PAYE', 100, COALESCE(p.paye,0), 0, FALSE,
         jsonb_build_object('backfill', true, 'from','paye')
  FROM public.payslips p WHERE COALESCE(p.paye,0) <> 0
  UNION ALL
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'NHIF', 'statutory', 'statutory_employee'::public.payslip_line_category,
         'NHIF / SHIF', 110, COALESCE(p.nhif,0), 0, FALSE,
         jsonb_build_object('backfill', true, 'from','nhif')
  FROM public.payslips p WHERE COALESCE(p.nhif,0) <> 0
  UNION ALL
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'NSSF', 'statutory', 'statutory_employee'::public.payslip_line_category,
         'NSSF', 120, COALESCE(p.nssf_employee,0), COALESCE(p.nssf_employer,0), FALSE,
         jsonb_build_object('backfill', true, 'from','nssf')
  FROM public.payslips p WHERE COALESCE(p.nssf_employee,0) <> 0 OR COALESCE(p.nssf_employer,0) <> 0
  UNION ALL
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'HOUSING_LEVY', 'statutory', 'statutory_employee'::public.payslip_line_category,
         'Housing Levy', 130, COALESCE(p.housing_levy,0), 0, FALSE,
         jsonb_build_object('backfill', true, 'from','housing_levy')
  FROM public.payslips p WHERE COALESCE(p.housing_levy,0) <> 0
  UNION ALL
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'PERSONAL_RELIEF', 'relief', 'deduction'::public.payslip_line_category,
         'Personal Relief', 200, -COALESCE(p.personal_relief,0), 0, FALSE,
         jsonb_build_object('backfill', true, 'from','personal_relief','sign','negative_is_relief')
  FROM public.payslips p WHERE COALESCE(p.personal_relief,0) <> 0
  UNION ALL
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'INSURANCE_RELIEF', 'relief', 'deduction'::public.payslip_line_category,
         'Insurance Relief', 210, -COALESCE(p.insurance_relief,0), 0, FALSE,
         jsonb_build_object('backfill', true, 'from','insurance_relief','sign','negative_is_relief')
  FROM public.payslips p WHERE COALESCE(p.insurance_relief,0) <> 0
  UNION ALL
  SELECT p.organization_id, p.business_id, p.id, p.payroll_run_id, p.employee_id,
         'LEAVE_DEDUCTION', 'deduction', 'deduction'::public.payslip_line_category,
         'Unpaid Leave', 300, COALESCE(p.leave_deduction,0), 0, FALSE,
         jsonb_build_object('backfill', true, 'from','leave_deduction')
  FROM public.payslips p WHERE COALESCE(p.leave_deduction,0) <> 0
) AS src(organization_id, business_id, payslip_id, payroll_run_id, employee_id,
        rule_code, rule_type, category, label, sequence,
        employee_amount, employer_amount, taxable, source)
WHERE NOT EXISTS (
  SELECT 1 FROM public.payslip_lines pl WHERE pl.payslip_id = src.payslip_id
);

-- BACKFILL contract_compensation_components from legacy contract columns
INSERT INTO public.contract_compensation_components
  (organization_id, business_id, contract_id, component_code, label, amount, recurrence, taxable, effective_from)
SELECT c.organization_id, c.business_id, c.id, 'HOUSING', 'Housing Allowance',
       COALESCE(c.housing_allowance,0), 'monthly', TRUE, c.start_date
FROM public.employee_contracts c
WHERE COALESCE(c.housing_allowance,0) <> 0
  AND NOT EXISTS (
    SELECT 1 FROM public.contract_compensation_components x
    WHERE x.contract_id = c.id AND x.component_code = 'HOUSING'
  );

INSERT INTO public.contract_compensation_components
  (organization_id, business_id, contract_id, component_code, label, amount, recurrence, taxable, effective_from)
SELECT c.organization_id, c.business_id, c.id, 'TRANSPORT', 'Transport Allowance',
       COALESCE(c.transport_allowance,0), 'monthly', TRUE, c.start_date
FROM public.employee_contracts c
WHERE COALESCE(c.transport_allowance,0) <> 0
  AND NOT EXISTS (
    SELECT 1 FROM public.contract_compensation_components x
    WHERE x.contract_id = c.id AND x.component_code = 'TRANSPORT'
  );
