
-- Employee Contracts table (Odoo-aligned foundational entity)
CREATE TABLE public.employee_contracts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  contract_reference TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'running', 'expired', 'cancelled')),
  wage NUMERIC NOT NULL DEFAULT 0,
  housing_allowance NUMERIC NOT NULL DEFAULT 0,
  transport_allowance NUMERIC NOT NULL DEFAULT 0,
  other_allowances JSONB NOT NULL DEFAULT '{}',
  working_schedule TEXT NOT NULL DEFAULT 'full_time' CHECK (working_schedule IN ('full_time', 'part_time', 'contract', 'freelance')),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, contract_reference)
);

-- Indexes
CREATE INDEX idx_employee_contracts_org ON public.employee_contracts(organization_id);
CREATE INDEX idx_employee_contracts_employee ON public.employee_contracts(employee_id);
CREATE INDEX idx_employee_contracts_status ON public.employee_contracts(status);

-- Enable RLS
ALTER TABLE public.employee_contracts ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view contracts in their organization"
  ON public.employee_contracts FOR SELECT
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users with manageEmployees can insert contracts"
  ON public.employee_contracts FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users with manageEmployees can update contracts"
  ON public.employee_contracts FOR UPDATE
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users with manageEmployees can delete contracts"
  ON public.employee_contracts FOR DELETE
  TO authenticated
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

-- Auto-update updated_at
CREATE TRIGGER update_employee_contracts_updated_at
  BEFORE UPDATE ON public.employee_contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RPC to generate next contract reference
CREATE OR REPLACE FUNCTION public.get_next_contract_reference(p_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num INTEGER;
  ref TEXT;
BEGIN
  SELECT COALESCE(MAX(
    CAST(NULLIF(regexp_replace(contract_reference, '[^0-9]', '', 'g'), '') AS INTEGER)
  ), 0) + 1
  INTO next_num
  FROM employee_contracts
  WHERE organization_id = p_org_id;

  ref := 'CON-' || LPAD(next_num::TEXT, 4, '0');
  RETURN ref;
END;
$$;

-- Trigger: when contract status changes to 'running', sync wage to employee
CREATE OR REPLACE FUNCTION public.sync_contract_to_employee()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'running' AND (OLD.status IS NULL OR OLD.status <> 'running') THEN
    UPDATE employees
    SET
      basic_salary = NEW.wage,
      housing_allowance = NEW.housing_allowance,
      transport_allowance = NEW.transport_allowance,
      other_allowances = NEW.other_allowances,
      updated_at = now()
    WHERE id = NEW.employee_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_contract_to_employee
  AFTER INSERT OR UPDATE ON public.employee_contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_contract_to_employee();
