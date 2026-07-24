-- =====================================================================
-- Phase A — Party spine consolidation for garnishment / legal-order lifecycle
-- =====================================================================
-- Adds Contact-role facet tables + new FK columns on legal_orders_records,
-- backfills from existing legal_order_authorities / legal_recipients rows,
-- and exposes compatibility views. Old tables & columns remain untouched.

-- ---------------------------------------------------------------------
-- 1. contact_authority_profile
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_authority_profile (
  contact_id UUID PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL,
  business_id UUID,
  authority_type TEXT,                       -- e.g. court, tax_authority, child_support_agency, sacco
  code TEXT,                                 -- optional short code used by localization packs
  jurisdiction_country TEXT,
  jurisdiction_region TEXT,
  statutory_id TEXT,
  default_payee_bank TEXT,
  default_payee_account TEXT,
  default_payee_reference_template TEXT,
  remittance_schedule_ref TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

CREATE INDEX IF NOT EXISTS idx_contact_authority_profile_org
  ON public.contact_authority_profile(organization_id);
CREATE INDEX IF NOT EXISTS idx_contact_authority_profile_code
  ON public.contact_authority_profile(organization_id, code)
  WHERE code IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_authority_profile TO authenticated;
GRANT ALL ON public.contact_authority_profile TO service_role;

ALTER TABLE public.contact_authority_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY contact_authority_profile_read
  ON public.contact_authority_profile FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
  ));

CREATE POLICY contact_authority_profile_write
  ON public.contact_authority_profile FOR ALL TO authenticated
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

CREATE TRIGGER trg_contact_authority_profile_updated_at
  BEFORE UPDATE ON public.contact_authority_profile
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

-- ---------------------------------------------------------------------
-- 2. contact_recipient_profile
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_recipient_profile (
  contact_id UUID PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL,
  business_id UUID,
  recipient_type_code TEXT,                  -- kind bucket (court, ird, sacco, creditor…)
  authority_contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  aggregate_cap_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  always_first BOOLEAN NOT NULL DEFAULT FALSE,
  default_payment_method_id UUID,
  default_payee_bank TEXT,
  default_payee_account TEXT,
  default_reference_template TEXT,
  statement_cadence TEXT,
  remittance_schedule_ref TEXT,
  jurisdiction_country TEXT,
  jurisdiction_region TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

CREATE INDEX IF NOT EXISTS idx_contact_recipient_profile_org
  ON public.contact_recipient_profile(organization_id);
CREATE INDEX IF NOT EXISTS idx_contact_recipient_profile_authority
  ON public.contact_recipient_profile(authority_contact_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_recipient_profile TO authenticated;
GRANT ALL ON public.contact_recipient_profile TO service_role;

ALTER TABLE public.contact_recipient_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY contact_recipient_profile_read
  ON public.contact_recipient_profile FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT uba.organization_id FROM public.user_business_access uba WHERE uba.user_id = auth.uid()
  ));

CREATE POLICY contact_recipient_profile_write
  ON public.contact_recipient_profile FOR ALL TO authenticated
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

CREATE TRIGGER trg_contact_recipient_profile_updated_at
  BEFORE UPDATE ON public.contact_recipient_profile
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

-- ---------------------------------------------------------------------
-- 3. legal_orders_records new FKs
-- ---------------------------------------------------------------------
ALTER TABLE public.legal_orders_records
  ADD COLUMN IF NOT EXISTS authority_contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recipient_contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_legal_orders_records_authority_contact
  ON public.legal_orders_records(authority_contact_id);
CREATE INDEX IF NOT EXISTS idx_legal_orders_records_recipient_contact
  ON public.legal_orders_records(recipient_contact_id);

-- ---------------------------------------------------------------------
-- 4. Backfill — authorities → contacts + authority profile
-- ---------------------------------------------------------------------
-- 4a) For every authority missing a contact link, create a Contact.
DO $$
DECLARE
  a RECORD;
  v_contact_id UUID;
  v_business_id UUID;
BEGIN
  FOR a IN
    SELECT loa.*
      FROM public.legal_order_authorities loa
     WHERE loa.contact_id IS NULL
  LOOP
    -- pick any business under the org as anchor (contacts.business_id is NOT NULL)
    SELECT b.id INTO v_business_id
      FROM public.businesses b
     WHERE b.organization_id = a.organization_id
     ORDER BY b.created_at ASC
     LIMIT 1;

    IF v_business_id IS NULL THEN
      CONTINUE; -- org has no business yet; skip, will retry on next migration/tenant setup
    END IF;

    INSERT INTO public.contacts (
      organization_id, business_id, name, type, is_company, is_active
    ) VALUES (
      a.organization_id, v_business_id, a.name, 'supplier'::public.contact_type, TRUE, COALESCE(a.is_active, TRUE)
    )
    RETURNING id INTO v_contact_id;

    UPDATE public.legal_order_authorities
       SET contact_id = v_contact_id
     WHERE id = a.id;
  END LOOP;
END $$;

-- 4b) Upsert authority profile rows from the (now fully linked) authorities.
INSERT INTO public.contact_authority_profile (
  contact_id, organization_id, authority_type, code,
  jurisdiction_country, jurisdiction_region,
  default_payee_bank, default_payee_account, default_payee_reference_template,
  remittance_schedule_ref, is_active
)
SELECT
  loa.contact_id,
  loa.organization_id,
  loa.authority_type,
  loa.code,
  loa.jurisdiction_country,
  loa.jurisdiction_region,
  loa.default_payee_bank,
  loa.default_payee_account,
  loa.default_payee_reference_template,
  loa.remittance_schedule_ref,
  COALESCE(loa.is_active, TRUE)
FROM public.legal_order_authorities loa
WHERE loa.contact_id IS NOT NULL
ON CONFLICT (contact_id) DO UPDATE SET
  authority_type = EXCLUDED.authority_type,
  code = COALESCE(public.contact_authority_profile.code, EXCLUDED.code),
  jurisdiction_country = COALESCE(public.contact_authority_profile.jurisdiction_country, EXCLUDED.jurisdiction_country),
  jurisdiction_region = COALESCE(public.contact_authority_profile.jurisdiction_region, EXCLUDED.jurisdiction_region),
  default_payee_bank = COALESCE(public.contact_authority_profile.default_payee_bank, EXCLUDED.default_payee_bank),
  default_payee_account = COALESCE(public.contact_authority_profile.default_payee_account, EXCLUDED.default_payee_account),
  default_payee_reference_template = COALESCE(public.contact_authority_profile.default_payee_reference_template, EXCLUDED.default_payee_reference_template),
  remittance_schedule_ref = COALESCE(public.contact_authority_profile.remittance_schedule_ref, EXCLUDED.remittance_schedule_ref),
  updated_at = now();

-- ---------------------------------------------------------------------
-- 5. Backfill — recipients → contacts + recipient profile
-- ---------------------------------------------------------------------
-- 5a) Promote un-linked legal_recipients into contacts.
DO $$
DECLARE
  r RECORD;
  v_contact_id UUID;
  v_business_id UUID;
BEGIN
  FOR r IN
    SELECT lr.*
      FROM public.legal_recipients lr
     WHERE lr.contact_id IS NULL
  LOOP
    SELECT b.id INTO v_business_id
      FROM public.businesses b
     WHERE b.organization_id = r.organization_id
     ORDER BY b.created_at ASC
     LIMIT 1;

    IF v_business_id IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.contacts (
      organization_id, business_id, name, type, is_company, is_active,
      email, phone, address_line1, tax_id
    ) VALUES (
      r.organization_id, v_business_id, r.display_name, 'supplier'::public.contact_type,
      TRUE, COALESCE(r.is_active, TRUE),
      r.contact_email, r.contact_phone, r.address, r.tax_id
    )
    RETURNING id INTO v_contact_id;

    UPDATE public.legal_recipients
       SET contact_id = v_contact_id
     WHERE id = r.id;
  END LOOP;
END $$;

-- 5b) Upsert recipient profile rows.
INSERT INTO public.contact_recipient_profile (
  contact_id, organization_id, recipient_type_code,
  authority_contact_id, aggregate_cap_exempt, always_first,
  default_payment_method_id, default_payee_bank, default_payee_account,
  default_reference_template, statement_cadence, remittance_schedule_ref,
  jurisdiction_country, jurisdiction_region, is_active, metadata
)
SELECT
  lr.contact_id,
  lr.organization_id,
  lr.recipient_type_code,
  loa.contact_id AS authority_contact_id,
  COALESCE(lr.aggregate_cap_exempt, FALSE),
  COALESCE(lr.always_first, FALSE),
  lr.default_payment_method_id,
  lr.default_payee_bank,
  lr.default_payee_account,
  lr.default_payee_reference_template,
  lr.statement_cadence,
  lr.remittance_schedule_ref,
  lr.jurisdiction_country,
  lr.jurisdiction_region,
  COALESCE(lr.is_active, TRUE),
  COALESCE(lr.metadata, '{}'::jsonb)
FROM public.legal_recipients lr
LEFT JOIN public.legal_order_authorities loa ON loa.id = lr.authority_id
WHERE lr.contact_id IS NOT NULL
ON CONFLICT (contact_id) DO UPDATE SET
  recipient_type_code = EXCLUDED.recipient_type_code,
  authority_contact_id = COALESCE(public.contact_recipient_profile.authority_contact_id, EXCLUDED.authority_contact_id),
  aggregate_cap_exempt = EXCLUDED.aggregate_cap_exempt,
  always_first = EXCLUDED.always_first,
  default_payment_method_id = COALESCE(public.contact_recipient_profile.default_payment_method_id, EXCLUDED.default_payment_method_id),
  default_payee_bank = COALESCE(public.contact_recipient_profile.default_payee_bank, EXCLUDED.default_payee_bank),
  default_payee_account = COALESCE(public.contact_recipient_profile.default_payee_account, EXCLUDED.default_payee_account),
  default_reference_template = COALESCE(public.contact_recipient_profile.default_reference_template, EXCLUDED.default_reference_template),
  statement_cadence = COALESCE(public.contact_recipient_profile.statement_cadence, EXCLUDED.statement_cadence),
  remittance_schedule_ref = COALESCE(public.contact_recipient_profile.remittance_schedule_ref, EXCLUDED.remittance_schedule_ref),
  jurisdiction_country = COALESCE(public.contact_recipient_profile.jurisdiction_country, EXCLUDED.jurisdiction_country),
  jurisdiction_region = COALESCE(public.contact_recipient_profile.jurisdiction_region, EXCLUDED.jurisdiction_region),
  updated_at = now();

-- ---------------------------------------------------------------------
-- 6. Backfill — legal_orders_records → authority_contact_id / recipient_contact_id
-- ---------------------------------------------------------------------
UPDATE public.legal_orders_records lor
   SET authority_contact_id = loa.contact_id
  FROM public.legal_order_authorities loa
 WHERE lor.authority_id = loa.id
   AND lor.authority_contact_id IS NULL
   AND loa.contact_id IS NOT NULL;

UPDATE public.legal_orders_records lor
   SET recipient_contact_id = lr.contact_id
  FROM public.legal_recipients lr
 WHERE lor.recipient_id = lr.id
   AND lor.recipient_contact_id IS NULL
   AND lr.contact_id IS NOT NULL;

-- Fallback: if the order carried a payee_contact_id but not a recipient linkage.
UPDATE public.legal_orders_records
   SET recipient_contact_id = payee_contact_id
 WHERE recipient_contact_id IS NULL
   AND payee_contact_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 7. Compatibility views (read-only projections over the new spine)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.legal_order_authorities_v AS
SELECT
  c.id                              AS id,
  c.id                              AS contact_id,
  cap.organization_id               AS organization_id,
  c.name                            AS name,
  cap.code                          AS code,
  cap.authority_type                AS authority_type,
  cap.jurisdiction_country          AS jurisdiction_country,
  cap.jurisdiction_region           AS jurisdiction_region,
  cap.default_payee_bank            AS default_payee_bank,
  cap.default_payee_account         AS default_payee_account,
  cap.default_payee_reference_template AS default_payee_reference_template,
  cap.remittance_schedule_ref       AS remittance_schedule_ref,
  c.email                           AS contact_email,
  c.phone                           AS contact_phone,
  COALESCE(cap.is_active, TRUE)     AS is_active,
  cap.created_at                    AS created_at,
  cap.updated_at                    AS updated_at
FROM public.contacts c
JOIN public.contact_authority_profile cap ON cap.contact_id = c.id;

GRANT SELECT ON public.legal_order_authorities_v TO authenticated;

CREATE OR REPLACE VIEW public.legal_recipients_v AS
SELECT
  c.id                              AS id,
  c.id                              AS contact_id,
  crp.organization_id               AS organization_id,
  c.name                            AS display_name,
  crp.recipient_type_code           AS recipient_type_code,
  crp.authority_contact_id          AS authority_id,
  crp.aggregate_cap_exempt          AS aggregate_cap_exempt,
  crp.always_first                  AS always_first,
  crp.default_payment_method_id     AS default_payment_method_id,
  crp.default_payee_bank            AS default_payee_bank,
  crp.default_payee_account         AS default_payee_account,
  crp.default_reference_template    AS default_payee_reference_template,
  crp.statement_cadence             AS statement_cadence,
  crp.remittance_schedule_ref       AS remittance_schedule_ref,
  crp.jurisdiction_country          AS jurisdiction_country,
  crp.jurisdiction_region           AS jurisdiction_region,
  c.email                           AS contact_email,
  c.phone                           AS contact_phone,
  c.address_line1                   AS address,
  c.tax_id                          AS tax_id,
  COALESCE(crp.is_active, TRUE)     AS is_active,
  crp.metadata                      AS metadata,
  crp.created_at                    AS created_at,
  crp.updated_at                    AS updated_at
FROM public.contacts c
JOIN public.contact_recipient_profile crp ON crp.contact_id = c.id;

GRANT SELECT ON public.legal_recipients_v TO authenticated;

-- ---------------------------------------------------------------------
-- 8. Documentation
-- ---------------------------------------------------------------------
COMMENT ON TABLE public.contact_authority_profile IS
  'Role facet of contacts: this Contact acts as an issuing authority (court, agency, tax authority) for legal orders / garnishments. See ADR 0092 and the garnishment lifecycle redesign plan.';
COMMENT ON TABLE public.contact_recipient_profile IS
  'Role facet of contacts: this Contact receives garnishment remittances. Sub-ledger partner for Garnishment Payable postings; used by remittance batches, recipient statements, and reconciliation.';
COMMENT ON COLUMN public.legal_orders_records.authority_contact_id IS
  'Canonical link to the issuing authority as a Contact (role: authority). Supersedes authority_id, which will be retired in a later phase.';
COMMENT ON COLUMN public.legal_orders_records.recipient_contact_id IS
  'Canonical link to the garnishment recipient as a Contact (role: garnishment_recipient). Supersedes recipient_id + free-text payee_* fields, which will be retired in a later phase.';
