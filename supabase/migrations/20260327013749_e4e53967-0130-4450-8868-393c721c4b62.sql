
-- Create payroll_remittances table for persistent remittance tracking
CREATE TABLE public.payroll_remittances (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  payroll_run_id UUID NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  remittance_type TEXT NOT NULL, -- e.g. 'paye', 'nssf', 'shif', 'housing_levy'
  remittance_label TEXT NOT NULL, -- Human-readable label e.g. 'PAYE Tax'
  amount NUMERIC NOT NULL DEFAULT 0,
  employer_amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'partial', 'overdue')),
  due_date DATE,
  payment_date DATE,
  reference_number TEXT,
  payment_method TEXT,
  notes TEXT,
  paid_by UUID REFERENCES auth.users(id),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(payroll_run_id, remittance_type)
);

-- Indexes
CREATE INDEX idx_payroll_remittances_org ON public.payroll_remittances(organization_id);
CREATE INDEX idx_payroll_remittances_run ON public.payroll_remittances(payroll_run_id);
CREATE INDEX idx_payroll_remittances_status ON public.payroll_remittances(status);

-- RLS
ALTER TABLE public.payroll_remittances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view remittances in their org"
  ON public.payroll_remittances FOR SELECT
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Finance users can insert remittances"
  ON public.payroll_remittances FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM public.user_roles 
      WHERE user_id = auth.uid() 
      AND role IN ('super_admin', 'owner', 'admin', 'accountant')
    )
  );

CREATE POLICY "Finance users can update remittances"
  ON public.payroll_remittances FOR UPDATE
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles 
      WHERE user_id = auth.uid() 
      AND role IN ('super_admin', 'owner', 'admin', 'accountant')
    )
  );

-- Add 'posted' status to payroll_runs (allow the new workflow state)
-- We need to update the status check if one exists, or just allow it via application logic
-- Since payroll_runs.status is TEXT without a CHECK constraint, no schema change needed for 'posted' status
