
ALTER TABLE public.payroll_liabilities
  ADD COLUMN IF NOT EXISTS garnishment_id   uuid NULL REFERENCES public.employee_garnishments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payee_contact_id uuid NULL REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_liabilities_garnishment
  ON public.payroll_liabilities(garnishment_id)
  WHERE garnishment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_liabilities_payee_contact
  ON public.payroll_liabilities(payee_contact_id)
  WHERE payee_contact_id IS NOT NULL;
