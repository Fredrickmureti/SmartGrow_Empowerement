
-- =====================================================================
-- Phase 1 — Legal Recipient master data
-- =====================================================================

-- 1. Recipient-type catalog (pack-seeded)
CREATE TABLE IF NOT EXISTS public.legal_recipient_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  label text NOT NULL,
  description text,
  is_government boolean NOT NULL DEFAULT false,
  default_always_first boolean NOT NULL DEFAULT false,
  default_cap_exempt boolean NOT NULL DEFAULT false,
  default_statement_cadence text
    CHECK (default_statement_cadence IN ('per_payment','monthly','quarterly','annual','on_request')),
  source_pack_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.legal_recipient_types TO authenticated;
GRANT ALL ON public.legal_recipient_types TO service_role;

ALTER TABLE public.legal_recipient_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY legal_recipient_types_read
  ON public.legal_recipient_types FOR SELECT TO authenticated
  USING (
    organization_id IS NULL
    OR organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
    )
  );

CREATE POLICY legal_recipient_types_write
  ON public.legal_recipient_types FOR ALL TO authenticated
  USING (
    organization_id IS NOT NULL
    AND organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
    )
    AND (
      public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
      OR public.has_role(auth.uid(),'accountant') OR public.has_role(auth.uid(),'super_admin')
    )
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND organization_id IN (
      SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
    )
    AND (
      public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'owner')
      OR public.has_role(auth.uid(),'accountant') OR public.has_role(auth.uid(),'super_admin')
    )
  );

CREATE TRIGGER trg_legal_recipient_types_updated_at
  BEFORE UPDATE ON public.legal_recipient_types
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.legal_recipient_types
  (organization_id, code, label, is_government, default_always_first, default_cap_exempt, default_statement_cadence, description)
VALUES
  (NULL, 'court',                 'Court',                       true,  false, false, 'monthly',    'Court registrar / clerk holding funds on behalf of a case.'),
  (NULL, 'child_support_agency',  'Child-Support Agency',        true,  true,  true,  'per_payment','Statutory child-support collection authority. Typically always-first and exempt from the aggregate cap.'),
  (NULL, 'tax_authority',         'Tax Authority (garnishment)', true,  false, false, 'monthly',    'Revenue authority acting as garnishor (distinct from PAYE tax remittance).'),
  (NULL, 'creditor',              'Creditor',                    false, false, false, 'monthly',    'Private creditor named on a court order (bank loan, credit card issuer, utility).'),
  (NULL, 'collection_agency',     'Collection Agency',           false, false, false, 'monthly',    'Debt-collection agency assigned by the original creditor.'),
  (NULL, 'bank_trustee',          'Bank / Trustee',              false, false, false, 'monthly',    'Bank or trustee holding funds under a legal instrument.'),
  (NULL, 'credit_union',          'SACCO / Credit Union',        false, false, false, 'monthly',    'Cooperative society acting as recipient of a check-off deduction.'),
  (NULL, 'labor_ministry',        'Labor Ministry',              true,  false, false, 'monthly',    'Statutory labor authority receiving deductions on behalf of an employee.'),
  (NULL, 'other',                 'Other',                       false, false, false, 'monthly',    'Any other legally recognized recipient not covered above.')
ON CONFLICT DO NOTHING;

-- 2. Legal Recipients master table
CREATE TABLE IF NOT EXISTS public.legal_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  recipient_type_code text NOT NULL,
  authority_id uuid REFERENCES public.legal_order_authorities(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  jurisdiction_country text,
  jurisdiction_region text,
  tax_id text,
  contact_email text,
  contact_phone text,
  address text,
  default_payee_bank text,
  default_payee_account text,
  default_payee_reference_template text,
  default_payment_method_id uuid REFERENCES public.organization_payment_methods(id) ON DELETE SET NULL,
  remittance_schedule_ref text,
  statement_cadence text
    CHECK (statement_cadence IN ('per_payment','monthly','quarterly','annual','on_request')),
  always_first boolean NOT NULL DEFAULT false,
  aggregate_cap_exempt boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_recipients_dedupe_uidx
  ON public.legal_recipients (
    organization_id,
    COALESCE(contact_id, '00000000-0000-0000-0000-000000000000'::uuid),
    recipient_type_code,
    COALESCE(jurisdiction_country, ''),
    COALESCE(jurisdiction_region, '')
  );

CREATE INDEX IF NOT EXISTS legal_recipients_org_active_idx
  ON public.legal_recipients (organization_id) WHERE is_active;

CREATE INDEX IF NOT EXISTS legal_recipients_authority_idx
  ON public.legal_recipients (authority_id) WHERE authority_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.legal_recipients TO authenticated;
GRANT ALL ON public.legal_recipients TO service_role;

ALTER TABLE public.legal_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY legal_recipients_read
  ON public.legal_recipients FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
  ));

CREATE POLICY legal_recipients_write
  ON public.legal_recipients FOR ALL TO authenticated
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

CREATE TRIGGER trg_legal_recipients_updated_at
  BEFORE UPDATE ON public.legal_recipients
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.legal_recipients IS
  'Phase 1: enterprise recipient master data for legal orders. Backed by a Contact for vendor-identity reuse; typed by pack-seeded legal_recipient_types.';

-- 3. Link column on legal orders
ALTER TABLE public.legal_orders_records
  ADD COLUMN IF NOT EXISTS recipient_id uuid
    REFERENCES public.legal_recipients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS legal_orders_records_recipient_idx
  ON public.legal_orders_records (recipient_id) WHERE recipient_id IS NOT NULL;

-- 4. Backfill
DO $backfill$
DECLARE
  r record;
  v_type text;
  v_recipient_id uuid;
BEGIN
  FOR r IN
    SELECT lor.id, lor.organization_id, lor.payee_contact_id, lor.authority_id,
           lor.kind::text AS kind_text, lor.payee_name, lor.payee_bank,
           lor.payee_account, lor.payee_reference, lor.payee_payment_method_id,
           lor.aggregate_cap_exempt, c.name AS contact_name, c.country AS contact_country
    FROM public.legal_orders_records lor
    LEFT JOIN public.contacts c ON c.id = lor.payee_contact_id
    WHERE lor.recipient_id IS NULL
      AND lor.payee_contact_id IS NOT NULL
  LOOP
    v_type := CASE r.kind_text
      WHEN 'child_support' THEN 'child_support_agency'
      WHEN 'tax_levy'      THEN 'tax_authority'
      WHEN 'court_order'   THEN 'court'
      WHEN 'creditor'      THEN 'creditor'
      WHEN 'student_loan'  THEN 'creditor'
      WHEN 'wage_assignment' THEN 'creditor'
      ELSE 'other'
    END;

    SELECT id INTO v_recipient_id
    FROM public.legal_recipients
    WHERE organization_id = r.organization_id
      AND contact_id IS NOT DISTINCT FROM r.payee_contact_id
      AND recipient_type_code = v_type
      AND COALESCE(jurisdiction_country,'') = COALESCE(r.contact_country,'')
      AND COALESCE(jurisdiction_region,'') = ''
    LIMIT 1;

    IF v_recipient_id IS NULL THEN
      INSERT INTO public.legal_recipients (
        organization_id, contact_id, recipient_type_code, authority_id,
        display_name, jurisdiction_country,
        default_payee_bank, default_payee_account, default_payee_reference_template,
        default_payment_method_id, aggregate_cap_exempt
      ) VALUES (
        r.organization_id, r.payee_contact_id, v_type, r.authority_id,
        COALESCE(r.contact_name, r.payee_name, 'Recipient'),
        r.contact_country,
        r.payee_bank, r.payee_account, r.payee_reference,
        r.payee_payment_method_id, COALESCE(r.aggregate_cap_exempt, false)
      )
      RETURNING id INTO v_recipient_id;
    END IF;

    UPDATE public.legal_orders_records
       SET recipient_id = v_recipient_id
     WHERE id = r.id;
  END LOOP;
END
$backfill$;

-- 5. Extend the enterprise view with recipient columns (drop-and-recreate
--    because column list changes).
DROP VIEW IF EXISTS public.legal_orders;
CREATE VIEW public.legal_orders
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
  d.source_pack_id             AS legal_behavior_pack_id,
  g.recipient_id,
  r.display_name               AS recipient_name,
  r.recipient_type_code        AS recipient_type,
  r.jurisdiction_country       AS recipient_jurisdiction_country,
  r.jurisdiction_region        AS recipient_jurisdiction_region,
  r.always_first               AS recipient_always_first_default,
  r.aggregate_cap_exempt       AS recipient_cap_exempt_default
FROM public.legal_orders_records g
LEFT JOIN public.garnishment_kind_defaults d
  ON d.organization_id = g.organization_id
 AND d.kind = g.kind::text
LEFT JOIN public.legal_recipients r
  ON r.id = g.recipient_id;

GRANT SELECT ON public.legal_orders TO authenticated;

-- 6. Merge RPC
CREATE OR REPLACE FUNCTION public.legal_recipient_merge(
  p_source_id uuid,
  p_target_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src public.legal_recipients%ROWTYPE;
  v_tgt public.legal_recipients%ROWTYPE;
  v_orders_moved int;
  v_uid uuid := auth.uid();
  v_is_priv boolean;
BEGIN
  IF p_source_id = p_target_id THEN
    RAISE EXCEPTION 'source and target must differ' USING HINT = 'INVALID_ARGUMENT';
  END IF;

  SELECT * INTO v_src FROM public.legal_recipients WHERE id = p_source_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'source recipient not found' USING HINT = 'NOT_FOUND'; END IF;

  SELECT * INTO v_tgt FROM public.legal_recipients WHERE id = p_target_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'target recipient not found' USING HINT = 'NOT_FOUND'; END IF;

  IF v_src.organization_id <> v_tgt.organization_id THEN
    RAISE EXCEPTION 'recipients belong to different organizations' USING HINT = 'ORG_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = v_uid AND uba.organization_id = v_src.organization_id
  ) THEN
    RAISE EXCEPTION 'not a member of the organization'
      USING HINT = 'PERMISSION_DENIED', ERRCODE = '42501';
  END IF;

  v_is_priv := public.has_role(v_uid,'admin')
            OR public.has_role(v_uid,'owner')
            OR public.has_role(v_uid,'accountant')
            OR public.has_role(v_uid,'super_admin');
  IF NOT v_is_priv THEN
    RAISE EXCEPTION 'insufficient role to merge recipients'
      USING HINT = 'PERMISSION_DENIED', ERRCODE = '42501';
  END IF;

  UPDATE public.legal_orders_records
     SET recipient_id = p_target_id,
         updated_at   = now()
   WHERE recipient_id = p_source_id;
  GET DIAGNOSTICS v_orders_moved = ROW_COUNT;

  UPDATE public.legal_recipients
     SET is_active = false,
         metadata = COALESCE(metadata,'{}'::jsonb)
                 || jsonb_build_object('merged_into', p_target_id, 'merged_at', now(), 'merged_by', v_uid),
         updated_at = now()
   WHERE id = p_source_id;

  RETURN jsonb_build_object(
    'source_id', p_source_id,
    'target_id', p_target_id,
    'orders_moved', v_orders_moved,
    'source_deactivated', true
  );
END
$$;

REVOKE ALL ON FUNCTION public.legal_recipient_merge(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_recipient_merge(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.legal_recipient_merge(uuid, uuid) IS
  'Phase 1: consolidate duplicate legal recipients. Moves orders onto the target and soft-deletes the source. Admin/accountant only.';
