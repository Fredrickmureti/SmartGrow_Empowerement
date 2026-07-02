
-- =============================================
-- 1. Employee Loans & Advances Table
-- =============================================
CREATE TABLE public.employee_loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  loan_number TEXT NOT NULL,
  loan_type TEXT NOT NULL DEFAULT 'loan' CHECK (loan_type IN ('loan', 'advance')),
  description TEXT,
  principal_amount NUMERIC NOT NULL CHECK (principal_amount > 0),
  interest_rate NUMERIC NOT NULL DEFAULT 0 CHECK (interest_rate >= 0),
  total_amount NUMERIC NOT NULL CHECK (total_amount > 0),
  amount_repaid NUMERIC NOT NULL DEFAULT 0 CHECK (amount_repaid >= 0),
  outstanding_balance NUMERIC NOT NULL CHECK (outstanding_balance >= 0),
  monthly_deduction NUMERIC NOT NULL CHECK (monthly_deduction > 0),
  total_installments INTEGER NOT NULL CHECK (total_installments > 0),
  installments_paid INTEGER NOT NULL DEFAULT 0 CHECK (installments_paid >= 0),
  start_date DATE NOT NULL,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'cancelled', 'suspended')),
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.employee_loans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view loans in their org"
  ON public.employee_loans FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users with managePayroll can manage loans"
  ON public.employee_loans FOR ALL TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

-- Loan repayment history
CREATE TABLE public.loan_repayments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES public.employee_loans(id) ON DELETE CASCADE,
  payroll_run_id UUID REFERENCES public.payroll_runs(id) ON DELETE SET NULL,
  payslip_id UUID REFERENCES public.payslips(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  repayment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  installment_number INTEGER NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.loan_repayments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view repayments in their org loans"
  ON public.loan_repayments FOR SELECT TO authenticated
  USING (
    loan_id IN (
      SELECT id FROM public.employee_loans WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
      )
    )
  );

CREATE POLICY "Users with managePayroll can manage repayments"
  ON public.loan_repayments FOR ALL TO authenticated
  USING (
    loan_id IN (
      SELECT id FROM public.employee_loans WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    loan_id IN (
      SELECT id FROM public.employee_loans WHERE organization_id IN (
        SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
      )
    )
  );

-- =============================================
-- 2. Payroll Account Mappings Table
-- =============================================
CREATE TABLE public.payroll_account_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  mapping_key TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, business_id, mapping_key)
);

ALTER TABLE public.payroll_account_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view mappings in their org"
  ON public.payroll_account_mappings FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users with managePayroll can manage mappings"
  ON public.payroll_account_mappings FOR ALL TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

-- =============================================
-- 3. Loan Number Sequence
-- =============================================
CREATE OR REPLACE FUNCTION public.get_next_loan_number(_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num INTEGER;
  result TEXT;
BEGIN
  SELECT COALESCE(MAX(
    CAST(NULLIF(regexp_replace(loan_number, '[^0-9]', '', 'g'), '') AS INTEGER)
  ), 0) + 1
  INTO next_num
  FROM public.employee_loans
  WHERE organization_id = _org_id;

  result := 'LN-' || LPAD(next_num::TEXT, 4, '0');
  RETURN result;
END;
$$;

-- =============================================
-- 4. Payroll Reversal Support
-- =============================================
ALTER TABLE public.payroll_runs 
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by UUID,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS original_run_id UUID REFERENCES public.payroll_runs(id),
  ADD COLUMN IF NOT EXISTS is_reversal BOOLEAN DEFAULT false;
