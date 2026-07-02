
-- Payroll Period Calendar table
CREATE TABLE IF NOT EXISTS public.payroll_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  period_type TEXT NOT NULL DEFAULT 'monthly',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  payment_date DATE,
  status TEXT NOT NULL DEFAULT 'open',
  payroll_run_id UUID REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  fiscal_year INTEGER,
  period_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_periods_unique UNIQUE (organization_id, business_id, start_date, end_date)
);

ALTER TABLE public.payroll_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payroll_periods_select" ON public.payroll_periods FOR SELECT TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'payroll', 'read'));

CREATE POLICY "payroll_periods_insert" ON public.payroll_periods FOR INSERT TO authenticated
  WITH CHECK (user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write'));

CREATE POLICY "payroll_periods_update" ON public.payroll_periods FOR UPDATE TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write'))
  WITH CHECK (user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write'));

CREATE POLICY "payroll_periods_delete" ON public.payroll_periods FOR DELETE TO authenticated
  USING (user_has_module_permission(auth.uid(), organization_id, 'payroll', 'delete'));

-- Function to generate payroll periods for a year
CREATE OR REPLACE FUNCTION public.generate_payroll_periods(
  p_org_id UUID,
  p_business_id UUID DEFAULT NULL,
  p_year INTEGER DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER,
  p_period_type TEXT DEFAULT 'monthly'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
  v_month INTEGER;
  v_start DATE;
  v_end DATE;
BEGIN
  IF p_period_type = 'monthly' THEN
    FOR v_month IN 1..12 LOOP
      v_start := make_date(p_year, v_month, 1);
      v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
      
      INSERT INTO payroll_periods (organization_id, business_id, name, period_type, start_date, end_date, fiscal_year, period_number)
      VALUES (p_org_id, p_business_id, TO_CHAR(v_start, 'Mon YYYY'), 'monthly', v_start, v_end, p_year, v_month)
      ON CONFLICT (organization_id, business_id, start_date, end_date) DO NOTHING;
      
      v_count := v_count + 1;
    END LOOP;
  END IF;
  
  RETURN v_count;
END;
$$;

-- Atomic payroll insert function
CREATE OR REPLACE FUNCTION public.insert_payroll_run_atomic(
  p_payroll_run JSONB,
  p_payslips JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id UUID;
  v_payslip JSONB;
  v_result JSONB;
BEGIN
  INSERT INTO payroll_runs (
    id, organization_id, business_id, payroll_number,
    pay_period_start, pay_period_end, status,
    total_gross, total_deductions, total_net,
    employee_count, created_by
  )
  VALUES (
    (p_payroll_run->>'id')::UUID,
    (p_payroll_run->>'organization_id')::UUID,
    NULLIF(p_payroll_run->>'business_id', '')::UUID,
    p_payroll_run->>'payroll_number',
    (p_payroll_run->>'pay_period_start')::DATE,
    (p_payroll_run->>'pay_period_end')::DATE,
    COALESCE(p_payroll_run->>'status', 'draft'),
    COALESCE((p_payroll_run->>'total_gross')::NUMERIC, 0),
    COALESCE((p_payroll_run->>'total_deductions')::NUMERIC, 0),
    COALESCE((p_payroll_run->>'total_net')::NUMERIC, 0),
    COALESCE((p_payroll_run->>'employee_count')::INTEGER, 0),
    NULLIF(p_payroll_run->>'created_by', '')::UUID
  )
  RETURNING id INTO v_run_id;

  FOR v_payslip IN SELECT * FROM jsonb_array_elements(p_payslips)
  LOOP
    INSERT INTO payslips (
      id, payroll_run_id, employee_id, organization_id, business_id,
      basic_salary, housing_allowance, transport_allowance, other_allowances,
      gross_pay, taxable_income, net_pay,
      paye, nssf_employee, nhif, housing_levy,
      nssf_employer, nhif_employer, housing_levy_employer,
      deductions_detail, employer_contributions_detail,
      earnings_detail, variable_earnings,
      proration_factor, unpaid_leave_days, overtime_hours, overtime_pay,
      loan_deductions
    )
    VALUES (
      COALESCE(NULLIF(v_payslip->>'id', '')::UUID, gen_random_uuid()),
      v_run_id,
      (v_payslip->>'employee_id')::UUID,
      (v_payslip->>'organization_id')::UUID,
      NULLIF(v_payslip->>'business_id', '')::UUID,
      COALESCE((v_payslip->>'basic_salary')::NUMERIC, 0),
      COALESCE((v_payslip->>'housing_allowance')::NUMERIC, 0),
      COALESCE((v_payslip->>'transport_allowance')::NUMERIC, 0),
      COALESCE((v_payslip->>'other_allowances')::NUMERIC, 0),
      COALESCE((v_payslip->>'gross_pay')::NUMERIC, 0),
      COALESCE((v_payslip->>'taxable_income')::NUMERIC, 0),
      COALESCE((v_payslip->>'net_pay')::NUMERIC, 0),
      COALESCE((v_payslip->>'paye')::NUMERIC, 0),
      COALESCE((v_payslip->>'nssf_employee')::NUMERIC, 0),
      COALESCE((v_payslip->>'nhif')::NUMERIC, 0),
      COALESCE((v_payslip->>'housing_levy')::NUMERIC, 0),
      COALESCE((v_payslip->>'nssf_employer')::NUMERIC, 0),
      COALESCE((v_payslip->>'nhif_employer')::NUMERIC, 0),
      COALESCE((v_payslip->>'housing_levy_employer')::NUMERIC, 0),
      COALESCE(v_payslip->'deductions_detail', '[]'::JSONB),
      COALESCE(v_payslip->'employer_contributions_detail', '[]'::JSONB),
      COALESCE(v_payslip->'earnings_detail', '[]'::JSONB),
      COALESCE(v_payslip->'variable_earnings', '{}'::JSONB),
      COALESCE((v_payslip->>'proration_factor')::NUMERIC, 1),
      COALESCE((v_payslip->>'unpaid_leave_days')::NUMERIC, 0),
      COALESCE((v_payslip->>'overtime_hours')::NUMERIC, 0),
      COALESCE((v_payslip->>'overtime_pay')::NUMERIC, 0),
      COALESCE(v_payslip->'loan_deductions', '[]'::JSONB)
    );
  END LOOP;

  v_result := jsonb_build_object(
    'payroll_run_id', v_run_id,
    'payslip_count', jsonb_array_length(p_payslips)
  );

  RETURN v_result;
END;
$$;
