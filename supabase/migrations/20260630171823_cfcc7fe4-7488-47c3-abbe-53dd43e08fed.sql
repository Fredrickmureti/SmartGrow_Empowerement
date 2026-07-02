
ALTER TABLE public.employee_garnishments
  ADD COLUMN IF NOT EXISTS payee_contact_id          uuid NULL REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payee_payment_method_id   uuid NULL REFERENCES public.organization_payment_methods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS employment_id             uuid NULL REFERENCES public.employments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payee_unmapped            boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_emp_garn_payee_contact ON public.employee_garnishments(payee_contact_id);
CREATE INDEX IF NOT EXISTS idx_emp_garn_employment    ON public.employee_garnishments(employment_id);
CREATE INDEX IF NOT EXISTS idx_emp_garn_unmapped      ON public.employee_garnishments(organization_id) WHERE payee_unmapped;

UPDATE public.employee_garnishments
   SET payee_unmapped = (payee_contact_id IS NULL);

CREATE OR REPLACE FUNCTION public.sync_order_recipient_mapping_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.payee_unmapped := (NEW.payee_contact_id IS NULL);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_emp_garn_sync_recipient_mapping ON public.employee_garnishments;
CREATE TRIGGER trg_emp_garn_sync_recipient_mapping
  BEFORE INSERT OR UPDATE OF payee_contact_id ON public.employee_garnishments
  FOR EACH ROW EXECUTE FUNCTION public.sync_order_recipient_mapping_flag();

INSERT INTO public.system_account_roles
  (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
VALUES
  ('garnishment_payable',
   'Garnishment Payable',
   'Liability account credited when an order-based deduction is withheld from a payslip; debited when the agency is remitted.',
   'liability', false, 'payroll', 250)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.payroll_readiness_rules
  (organization_id, code, name, description, scope, severity, source, reason_code, check_kind, remediation_label, remediation_link, sort_order)
VALUES
  (NULL, 'garnishment.payee_mapped',
   'Garnishment payee mapped',
   'Active garnishment orders must reference a Contact as the payee so the agency can be paid through the platform.',
   'org', 'block', 'core', 'GARNISHMENT_PAYEE_UNMAPPED',
   'garnishment.payee_mapped',
   'Map garnishment payees', '/hr/payroll/garnishments', 410),
  (NULL, 'garnishment.liability_account_mapped',
   'Garnishment liability account mapped',
   'A garnishment_payable liability account must be mapped before garnishment deductions can post to the GL.',
   'org', 'block', 'core', 'GARNISHMENT_LIABILITY_ACCOUNT_MISSING',
   'garnishment.liability_account_mapped',
   'Map garnishment payable account', '/hr/payroll/account-mapping', 420),
  (NULL, 'garnishment.evidence_document',
   'Garnishment evidence document attached',
   'Court-ordered garnishments should have a supporting document attached for compliance.',
   'org', 'warn', 'core', 'GARNISHMENT_DOCUMENT_MISSING',
   'garnishment.evidence_document',
   'Attach evidence', '/hr/payroll/garnishments', 430)
ON CONFLICT (organization_id, code) DO NOTHING;
