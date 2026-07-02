-- Loans & Advances overhaul (Stage 5 + 6)

-- 1. Permission helper
CREATE OR REPLACE FUNCTION public.has_payroll_access(_user_id uuid, _org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    public.has_org_role(_user_id, _org_id, 'admin')
    OR public.has_org_role(_user_id, _org_id, 'owner')
    OR public.user_has_module_permission(_user_id, _org_id, 'payroll', 'manage')
    OR public.user_has_module_permission(_user_id, _org_id, 'payroll', 'view')
    OR public.user_has_module_permission(_user_id, _org_id, 'hr', 'manage');
$$;

-- 2. loan_types
CREATE TABLE IF NOT EXISTS public.loan_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'loan' CHECK (kind IN ('loan','salary_advance','emergency','asset','custom')),
  description TEXT,
  requires_interest BOOLEAN NOT NULL DEFAULT false,
  requires_schedule BOOLEAN NOT NULL DEFAULT true,
  requires_approval BOOLEAN NOT NULL DEFAULT true,
  default_repayment_method TEXT NOT NULL DEFAULT 'fixed_installment'
    CHECK (default_repayment_method IN ('fixed_installment','fixed_amount','percent_of_net','one_off_next_payroll')),
  default_installments INTEGER,
  default_max_pct_of_net NUMERIC,
  default_min_net_pay_floor NUMERIC,
  gl_receivable_account_id UUID,
  gl_disbursement_clearing_account_id UUID,
  salary_rule_code TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS loan_types_org_biz_code_uidx
  ON public.loan_types(organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
CREATE INDEX IF NOT EXISTS idx_loan_types_org ON public.loan_types(organization_id);

ALTER TABLE public.loan_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "loan_types_select" ON public.loan_types;
CREATE POLICY "loan_types_select" ON public.loan_types FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "loan_types_manage" ON public.loan_types;
CREATE POLICY "loan_types_manage" ON public.loan_types FOR ALL TO authenticated
USING (public.has_payroll_access(auth.uid(), organization_id))
WITH CHECK (public.has_payroll_access(auth.uid(), organization_id));

-- 3. Extend employee_loans
ALTER TABLE public.employee_loans
  ADD COLUMN IF NOT EXISTS loan_type_id UUID REFERENCES public.loan_types(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS repayment_method TEXT NOT NULL DEFAULT 'fixed_installment',
  ADD COLUMN IF NOT EXISTS repayment_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS min_net_pay_floor NUMERIC,
  ADD COLUMN IF NOT EXISTS max_pct_of_net NUMERIC,
  ADD COLUMN IF NOT EXISTS paused_until DATE,
  ADD COLUMN IF NOT EXISTS disbursement_journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS settlement_journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS disbursed_at TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_loans_repayment_method_check') THEN
    ALTER TABLE public.employee_loans
      ADD CONSTRAINT employee_loans_repayment_method_check
      CHECK (repayment_method IN ('fixed_installment','fixed_amount','percent_of_net','one_off_next_payroll'));
  END IF;
END $$;

-- 4. loan_repayment_schedule
CREATE TABLE IF NOT EXISTS public.loan_repayment_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES public.employee_loans(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  due_period_start DATE,
  due_period_end DATE,
  scheduled_amount NUMERIC NOT NULL CHECK (scheduled_amount >= 0),
  paid_amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','partial','skipped','cancelled')),
  payslip_id UUID REFERENCES public.payslips(id) ON DELETE SET NULL,
  repayment_id UUID REFERENCES public.loan_repayments(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (loan_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_loan_schedule_loan ON public.loan_repayment_schedule(loan_id);
CREATE INDEX IF NOT EXISTS idx_loan_schedule_status ON public.loan_repayment_schedule(status);

ALTER TABLE public.loan_repayment_schedule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "loan_schedule_select" ON public.loan_repayment_schedule;
CREATE POLICY "loan_schedule_select" ON public.loan_repayment_schedule FOR SELECT TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.employee_loans el
          LEFT JOIN public.employees e ON e.id = el.employee_id
          WHERE el.id = loan_repayment_schedule.loan_id
            AND (public.has_payroll_access(auth.uid(), el.organization_id) OR e.user_id = auth.uid()))
);
DROP POLICY IF EXISTS "loan_schedule_manage" ON public.loan_repayment_schedule;
CREATE POLICY "loan_schedule_manage" ON public.loan_repayment_schedule FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.employee_loans el WHERE el.id = loan_repayment_schedule.loan_id AND public.has_payroll_access(auth.uid(), el.organization_id)))
WITH CHECK (EXISTS (SELECT 1 FROM public.employee_loans el WHERE el.id = loan_repayment_schedule.loan_id AND public.has_payroll_access(auth.uid(), el.organization_id)));

-- 5. Tighten RLS on employee_loans + loan_repayments
DROP POLICY IF EXISTS "Users can view loans in their org" ON public.employee_loans;
DROP POLICY IF EXISTS "Users with managePayroll can manage loans" ON public.employee_loans;
DROP POLICY IF EXISTS "employee_loans_select" ON public.employee_loans;
DROP POLICY IF EXISTS "employee_loans_manage" ON public.employee_loans;

CREATE POLICY "employee_loans_select" ON public.employee_loans FOR SELECT TO authenticated
USING (
  public.has_payroll_access(auth.uid(), organization_id)
  OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id = employee_loans.employee_id AND e.user_id = auth.uid())
);
CREATE POLICY "employee_loans_manage" ON public.employee_loans FOR ALL TO authenticated
USING (public.has_payroll_access(auth.uid(), organization_id))
WITH CHECK (public.has_payroll_access(auth.uid(), organization_id));

DROP POLICY IF EXISTS "Users can view repayments in their org loans" ON public.loan_repayments;
DROP POLICY IF EXISTS "Users with managePayroll can manage repayments" ON public.loan_repayments;
DROP POLICY IF EXISTS "loan_repayments_select" ON public.loan_repayments;
DROP POLICY IF EXISTS "loan_repayments_manage" ON public.loan_repayments;

CREATE POLICY "loan_repayments_select" ON public.loan_repayments FOR SELECT TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.employee_loans el LEFT JOIN public.employees e ON e.id = el.employee_id
          WHERE el.id = loan_repayments.loan_id
            AND (public.has_payroll_access(auth.uid(), el.organization_id) OR e.user_id = auth.uid()))
);
CREATE POLICY "loan_repayments_manage" ON public.loan_repayments FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.employee_loans el WHERE el.id = loan_repayments.loan_id AND public.has_payroll_access(auth.uid(), el.organization_id)))
WITH CHECK (EXISTS (SELECT 1 FROM public.employee_loans el WHERE el.id = loan_repayments.loan_id AND public.has_payroll_access(auth.uid(), el.organization_id)));

-- 6. seed_default_loan_types
CREATE OR REPLACE FUNCTION public.seed_default_loan_types(_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.loan_types
    (organization_id, code, name, kind, description, requires_interest, requires_schedule, requires_approval,
     default_repayment_method, default_installments, default_max_pct_of_net)
  VALUES
    (_org_id,'LOAN','Employee Loan','loan','Standard repayable loan with installment schedule.',true,true,true,'fixed_installment',12,33),
    (_org_id,'SAL_ADV','Salary Advance','salary_advance','Short-term advance recovered from the next payroll.',false,false,true,'one_off_next_payroll',1,50),
    (_org_id,'EMERGENCY','Emergency Loan','emergency','Fast-track loan for emergencies, optional interest.',false,true,true,'fixed_installment',6,25),
    (_org_id,'ASSET','Asset Loan','asset','Loan for company-purchased assets.',true,true,true,'fixed_installment',24,25)
  ON CONFLICT DO NOTHING;
END;
$$;

-- 7. generate_loan_schedule
CREATE OR REPLACE FUNCTION public.generate_loan_schedule(_loan_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  l RECORD; i INTEGER; amt NUMERIC; remaining NUMERIC;
  period_start DATE; period_end DATE; n INTEGER;
BEGIN
  SELECT * INTO l FROM public.employee_loans WHERE id = _loan_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  DELETE FROM public.loan_repayment_schedule
   WHERE loan_id = _loan_id AND status IN ('pending','skipped','cancelled');
  IF l.repayment_method = 'one_off_next_payroll' THEN
    INSERT INTO public.loan_repayment_schedule (loan_id, sequence, due_period_start, scheduled_amount)
    VALUES (_loan_id, 1, l.start_date, l.outstanding_balance)
    ON CONFLICT (loan_id, sequence) DO NOTHING;
    RETURN 1;
  END IF;
  IF l.repayment_method = 'percent_of_net' THEN RETURN 0; END IF;
  n := COALESCE(l.total_installments, 12);
  IF n <= 0 THEN n := 12; END IF;
  amt := ROUND(l.total_amount / n, 2);
  remaining := l.total_amount;
  period_start := l.start_date;
  FOR i IN 1..n LOOP
    period_end := (period_start + INTERVAL '1 month' - INTERVAL '1 day')::date;
    IF i = n THEN amt := remaining; END IF;
    INSERT INTO public.loan_repayment_schedule (loan_id, sequence, due_period_start, due_period_end, scheduled_amount)
    VALUES (_loan_id, i, period_start, period_end, amt) ON CONFLICT (loan_id, sequence) DO NOTHING;
    remaining := remaining - amt;
    period_start := (period_start + INTERVAL '1 month')::date;
  END LOOP;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_loan_schedule(_loan_id uuid)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ SELECT public.generate_loan_schedule(_loan_id); $$;