
-- Phase 3 — Legal Orders domain rename + structured authorities.

-- 1. Legal Order Authorities (structured reference data).
CREATE TABLE IF NOT EXISTS public.legal_order_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  authority_type text NOT NULL CHECK (authority_type IN (
    'court','tax_agency','child_support_agency','labor_ministry','statutory_body','other'
  )),
  jurisdiction_country text,
  jurisdiction_region text,
  contact_email text,
  contact_phone text,
  address text,
  remittance_schedule_ref text,
  reporting_binding_ref text,
  default_payee_bank text,
  default_payee_account text,
  default_payee_reference_template text,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.legal_order_authorities TO authenticated;
GRANT ALL ON public.legal_order_authorities TO service_role;

ALTER TABLE public.legal_order_authorities ENABLE ROW LEVEL SECURITY;

CREATE POLICY legal_order_authorities_read
  ON public.legal_order_authorities FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
  ));

CREATE POLICY legal_order_authorities_write
  ON public.legal_order_authorities FOR ALL TO authenticated
  USING (
    organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
    ) AND (
      public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
      OR public.has_role(auth.uid(),'accountant') OR public.has_role(auth.uid(),'super_admin')
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
    ) AND (
      public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
      OR public.has_role(auth.uid(),'accountant') OR public.has_role(auth.uid(),'super_admin')
    )
  );

CREATE TRIGGER trg_legal_order_authorities_updated_at
  BEFORE UPDATE ON public.legal_order_authorities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Structured FK from the order to its authority (nullable — legacy rows
--    keep the free-text `issuing_authority` string).
ALTER TABLE public.employee_garnishments
  ADD COLUMN IF NOT EXISTS authority_id uuid REFERENCES public.legal_order_authorities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS employee_garnishments_authority_id_idx
  ON public.employee_garnishments(authority_id) WHERE authority_id IS NOT NULL;

-- 3. Legal Orders view — enterprise-domain alias over the physical table.
--    SECURITY INVOKER so RLS on employee_garnishments applies to readers.
CREATE OR REPLACE VIEW public.legal_orders
WITH (security_invoker = true) AS
SELECT
  g.id                        AS id,
  g.organization_id,
  g.business_id,
  g.employee_id,
  g.employment_id,
  g.kind                      AS kind_code,
  g.priority,
  g.case_reference,
  g.issuing_authority         AS issuing_authority_text,
  g.authority_id,
  g.cap_rule,
  g.fixed_amount,
  g.percent_of_disposable,
  g.total_owed,
  g.total_paid,
  g.total_accrued,
  g.start_date,
  g.end_date,
  g.is_active,
  g.aggregate_cap_exempt,
  g.minimum_take_home_amount,
  g.status,
  g.status_changed_at,
  g.status_changed_by,
  g.status_reason,
  g.payee_name,
  g.payee_bank,
  g.payee_account,
  g.payee_reference,
  g.payee_contact_id,
  g.payee_payment_method_id,
  g.payee_unmapped,
  g.document_url,
  g.document_filename,
  g.notes,
  g.created_by,
  g.created_at,
  g.updated_at,
  d.calc_model,
  d.priority_class,
  d.protected_earnings_rule,
  d.aggregate_cap_membership,
  d.remittance_schedule_ref,
  d.evidence_requirements,
  d.completion_rule,
  d.reporting_binding_ref,
  d.source_pack_id             AS legal_behavior_pack_id
FROM public.employee_garnishments g
LEFT JOIN public.garnishment_kind_defaults d
  ON d.organization_id = g.organization_id
 AND d.kind = g.kind::text;

GRANT SELECT ON public.legal_orders TO authenticated;

COMMENT ON VIEW public.legal_orders IS
  'Phase 3: enterprise-domain view over employee_garnishments joined with the resolved kind contract from garnishment_kind_defaults. security_invoker so RLS on the base table applies.';
