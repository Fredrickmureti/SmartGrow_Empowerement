
-- ============================================================
-- Phase B: canonical Party writers for legal-order roles.
-- Introduces two SECURITY DEFINER RPCs that write the Contact
-- spine + role facet profile atomically, and back-fill the
-- legacy authority/recipient tables for read-side continuity.
-- ============================================================

CREATE OR REPLACE FUNCTION public.party_upsert_authority_from_form(
  p_organization_id uuid,
  p_business_id     uuid,
  p_contact_id      uuid,
  p_name            text,
  p_is_company      boolean DEFAULT true,
  p_email           text DEFAULT NULL,
  p_phone           text DEFAULT NULL,
  p_address_line1   text DEFAULT NULL,
  p_city            text DEFAULT NULL,
  p_state           text DEFAULT NULL,
  p_postal_code     text DEFAULT NULL,
  p_country         text DEFAULT NULL,
  p_tax_id          text DEFAULT NULL,
  p_notes           text DEFAULT NULL,
  -- authority profile fields
  p_authority_type              text DEFAULT 'court',
  p_code                        text DEFAULT NULL,
  p_jurisdiction_country        text DEFAULT NULL,
  p_jurisdiction_region         text DEFAULT NULL,
  p_statutory_id                text DEFAULT NULL,
  p_default_payee_bank          text DEFAULT NULL,
  p_default_payee_account       text DEFAULT NULL,
  p_default_payee_reference_template text DEFAULT NULL,
  p_remittance_schedule_ref     text DEFAULT NULL,
  p_metadata                    jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_contact_id   uuid := p_contact_id;
  v_legacy_id    uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'ORG_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- Org membership guard: user must be a member of the org.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.organization_id = p_organization_id
      AND om.user_id = v_uid
      AND COALESCE(om.status, 'active') = 'active'
  ) THEN
    RAISE EXCEPTION 'ORG_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;

  IF coalesce(btrim(p_name), '') = '' THEN
    RAISE EXCEPTION 'NAME_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- Contact upsert (party-only: customer_rank=0, supplier_rank=0, type=null)
  IF v_contact_id IS NULL THEN
    INSERT INTO public.contacts(
      organization_id, business_id, name, is_company,
      email, phone, address_line1, city, state, postal_code, country,
      tax_id, notes, customer_rank, supplier_rank, type, is_active
    )
    VALUES (
      p_organization_id, p_business_id, btrim(p_name), coalesce(p_is_company, true),
      nullif(btrim(p_email), ''), nullif(btrim(p_phone), ''),
      nullif(btrim(p_address_line1), ''), nullif(btrim(p_city), ''),
      nullif(btrim(p_state), ''), nullif(btrim(p_postal_code), ''), nullif(btrim(p_country), ''),
      nullif(btrim(p_tax_id), ''), nullif(btrim(p_notes), ''),
      0, 0, NULL, true
    )
    RETURNING id INTO v_contact_id;
  ELSE
    UPDATE public.contacts SET
      name          = btrim(p_name),
      is_company    = coalesce(p_is_company, is_company),
      email         = coalesce(nullif(btrim(p_email), ''), email),
      phone         = coalesce(nullif(btrim(p_phone), ''), phone),
      address_line1 = coalesce(nullif(btrim(p_address_line1), ''), address_line1),
      city          = coalesce(nullif(btrim(p_city), ''), city),
      state         = coalesce(nullif(btrim(p_state), ''), state),
      postal_code   = coalesce(nullif(btrim(p_postal_code), ''), postal_code),
      country       = coalesce(nullif(btrim(p_country), ''), country),
      tax_id        = coalesce(nullif(btrim(p_tax_id), ''), tax_id),
      notes         = coalesce(nullif(btrim(p_notes), ''), notes)
    WHERE id = v_contact_id AND organization_id = p_organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CONTACT_NOT_FOUND' USING ERRCODE = '02000';
    END IF;
  END IF;

  -- Role facet upsert
  INSERT INTO public.contact_authority_profile(
    contact_id, organization_id, business_id,
    authority_type, code, jurisdiction_country, jurisdiction_region,
    statutory_id, default_payee_bank, default_payee_account,
    default_payee_reference_template, remittance_schedule_ref,
    is_active, metadata, created_by
  )
  VALUES (
    v_contact_id, p_organization_id, p_business_id,
    coalesce(nullif(btrim(p_authority_type), ''), 'court'),
    nullif(btrim(p_code), ''),
    nullif(btrim(p_jurisdiction_country), ''),
    nullif(btrim(p_jurisdiction_region), ''),
    nullif(btrim(p_statutory_id), ''),
    nullif(btrim(p_default_payee_bank), ''),
    nullif(btrim(p_default_payee_account), ''),
    nullif(btrim(p_default_payee_reference_template), ''),
    nullif(btrim(p_remittance_schedule_ref), ''),
    true, coalesce(p_metadata, '{}'::jsonb), v_uid
  )
  ON CONFLICT (contact_id) DO UPDATE SET
    authority_type       = EXCLUDED.authority_type,
    code                 = coalesce(EXCLUDED.code, contact_authority_profile.code),
    jurisdiction_country = coalesce(EXCLUDED.jurisdiction_country, contact_authority_profile.jurisdiction_country),
    jurisdiction_region  = coalesce(EXCLUDED.jurisdiction_region, contact_authority_profile.jurisdiction_region),
    statutory_id         = coalesce(EXCLUDED.statutory_id, contact_authority_profile.statutory_id),
    default_payee_bank   = coalesce(EXCLUDED.default_payee_bank, contact_authority_profile.default_payee_bank),
    default_payee_account = coalesce(EXCLUDED.default_payee_account, contact_authority_profile.default_payee_account),
    default_payee_reference_template = coalesce(EXCLUDED.default_payee_reference_template, contact_authority_profile.default_payee_reference_template),
    remittance_schedule_ref = coalesce(EXCLUDED.remittance_schedule_ref, contact_authority_profile.remittance_schedule_ref),
    is_active            = true,
    metadata             = contact_authority_profile.metadata || coalesce(EXCLUDED.metadata, '{}'::jsonb),
    updated_at           = now();

  -- Legacy back-fill so pre-Phase-B readers keep working.
  -- Match on contact_id first (post-Phase-A backfill), else on code.
  SELECT id INTO v_legacy_id
    FROM public.legal_order_authorities
   WHERE organization_id = p_organization_id
     AND (contact_id = v_contact_id
          OR (p_code IS NOT NULL AND code = btrim(p_code)))
   ORDER BY (contact_id = v_contact_id) DESC
   LIMIT 1;

  IF v_legacy_id IS NULL THEN
    INSERT INTO public.legal_order_authorities(
      organization_id, code, name, authority_type,
      jurisdiction_country, jurisdiction_region,
      default_payee_bank, default_payee_account, default_payee_reference_template,
      remittance_schedule_ref, contact_id, contact_email, contact_phone, is_active
    )
    VALUES (
      p_organization_id,
      coalesce(nullif(btrim(p_code), ''),
               'AUTH-' || upper(substr(replace(v_contact_id::text, '-', ''), 1, 10))),
      btrim(p_name),
      coalesce(nullif(btrim(p_authority_type), ''), 'court'),
      nullif(btrim(p_jurisdiction_country), ''),
      nullif(btrim(p_jurisdiction_region), ''),
      nullif(btrim(p_default_payee_bank), ''),
      nullif(btrim(p_default_payee_account), ''),
      nullif(btrim(p_default_payee_reference_template), ''),
      nullif(btrim(p_remittance_schedule_ref), ''),
      v_contact_id,
      nullif(btrim(p_email), ''),
      nullif(btrim(p_phone), ''),
      true
    )
    RETURNING id INTO v_legacy_id;
  ELSE
    UPDATE public.legal_order_authorities SET
      name                             = btrim(p_name),
      authority_type                   = coalesce(nullif(btrim(p_authority_type), ''), authority_type),
      jurisdiction_country             = coalesce(nullif(btrim(p_jurisdiction_country), ''), jurisdiction_country),
      jurisdiction_region              = coalesce(nullif(btrim(p_jurisdiction_region), ''), jurisdiction_region),
      default_payee_bank               = coalesce(nullif(btrim(p_default_payee_bank), ''), default_payee_bank),
      default_payee_account            = coalesce(nullif(btrim(p_default_payee_account), ''), default_payee_account),
      default_payee_reference_template = coalesce(nullif(btrim(p_default_payee_reference_template), ''), default_payee_reference_template),
      remittance_schedule_ref          = coalesce(nullif(btrim(p_remittance_schedule_ref), ''), remittance_schedule_ref),
      contact_id                       = coalesce(contact_id, v_contact_id),
      contact_email                    = coalesce(nullif(btrim(p_email), ''), contact_email),
      contact_phone                    = coalesce(nullif(btrim(p_phone), ''), contact_phone),
      is_active                        = true
    WHERE id = v_legacy_id;
  END IF;

  RETURN jsonb_build_object(
    'contact_id',  v_contact_id,
    'authority_id', v_legacy_id
  );
END $$;

GRANT EXECUTE ON FUNCTION public.party_upsert_authority_from_form(
  uuid, uuid, uuid, text, boolean, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, text, text, jsonb
) TO authenticated;


CREATE OR REPLACE FUNCTION public.party_upsert_recipient_from_form(
  p_organization_id uuid,
  p_business_id     uuid,
  p_contact_id      uuid,
  p_name            text,
  p_is_company      boolean DEFAULT true,
  p_email           text DEFAULT NULL,
  p_phone           text DEFAULT NULL,
  p_address_line1   text DEFAULT NULL,
  p_city            text DEFAULT NULL,
  p_state           text DEFAULT NULL,
  p_postal_code     text DEFAULT NULL,
  p_country         text DEFAULT NULL,
  p_tax_id          text DEFAULT NULL,
  p_notes           text DEFAULT NULL,
  -- recipient profile
  p_recipient_type_code text DEFAULT 'creditor',
  p_authority_contact_id uuid DEFAULT NULL,
  p_default_payee_bank   text DEFAULT NULL,
  p_default_payee_account text DEFAULT NULL,
  p_default_reference_template text DEFAULT NULL,
  p_remittance_schedule_ref text DEFAULT NULL,
  p_statement_cadence text DEFAULT NULL,
  p_jurisdiction_country text DEFAULT NULL,
  p_jurisdiction_region text DEFAULT NULL,
  p_always_first boolean DEFAULT false,
  p_aggregate_cap_exempt boolean DEFAULT false,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_contact_id uuid := p_contact_id;
  v_legacy_id  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'ORG_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.organization_id = p_organization_id
      AND om.user_id = v_uid
      AND COALESCE(om.status, 'active') = 'active'
  ) THEN
    RAISE EXCEPTION 'ORG_ACCESS_DENIED' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_name), '') = '' THEN
    RAISE EXCEPTION 'NAME_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF v_contact_id IS NULL THEN
    INSERT INTO public.contacts(
      organization_id, business_id, name, is_company,
      email, phone, address_line1, city, state, postal_code, country,
      tax_id, notes, customer_rank, supplier_rank, type, is_active
    )
    VALUES (
      p_organization_id, p_business_id, btrim(p_name), coalesce(p_is_company, true),
      nullif(btrim(p_email), ''), nullif(btrim(p_phone), ''),
      nullif(btrim(p_address_line1), ''), nullif(btrim(p_city), ''),
      nullif(btrim(p_state), ''), nullif(btrim(p_postal_code), ''), nullif(btrim(p_country), ''),
      nullif(btrim(p_tax_id), ''), nullif(btrim(p_notes), ''),
      0, 0, NULL, true
    )
    RETURNING id INTO v_contact_id;
  ELSE
    UPDATE public.contacts SET
      name          = btrim(p_name),
      is_company    = coalesce(p_is_company, is_company),
      email         = coalesce(nullif(btrim(p_email), ''), email),
      phone         = coalesce(nullif(btrim(p_phone), ''), phone),
      address_line1 = coalesce(nullif(btrim(p_address_line1), ''), address_line1),
      city          = coalesce(nullif(btrim(p_city), ''), city),
      state         = coalesce(nullif(btrim(p_state), ''), state),
      postal_code   = coalesce(nullif(btrim(p_postal_code), ''), postal_code),
      country       = coalesce(nullif(btrim(p_country), ''), country),
      tax_id        = coalesce(nullif(btrim(p_tax_id), ''), tax_id),
      notes         = coalesce(nullif(btrim(p_notes), ''), notes)
    WHERE id = v_contact_id AND organization_id = p_organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CONTACT_NOT_FOUND' USING ERRCODE = '02000';
    END IF;
  END IF;

  INSERT INTO public.contact_recipient_profile(
    contact_id, organization_id, business_id,
    recipient_type_code, authority_contact_id,
    default_payee_bank, default_payee_account, default_reference_template,
    remittance_schedule_ref, statement_cadence,
    jurisdiction_country, jurisdiction_region,
    always_first, aggregate_cap_exempt,
    is_active, metadata, created_by
  )
  VALUES (
    v_contact_id, p_organization_id, p_business_id,
    coalesce(nullif(btrim(p_recipient_type_code), ''), 'creditor'),
    p_authority_contact_id,
    nullif(btrim(p_default_payee_bank), ''),
    nullif(btrim(p_default_payee_account), ''),
    nullif(btrim(p_default_reference_template), ''),
    nullif(btrim(p_remittance_schedule_ref), ''),
    nullif(btrim(p_statement_cadence), ''),
    nullif(btrim(p_jurisdiction_country), ''),
    nullif(btrim(p_jurisdiction_region), ''),
    coalesce(p_always_first, false),
    coalesce(p_aggregate_cap_exempt, false),
    true, coalesce(p_metadata, '{}'::jsonb), v_uid
  )
  ON CONFLICT (contact_id) DO UPDATE SET
    recipient_type_code     = EXCLUDED.recipient_type_code,
    authority_contact_id    = coalesce(EXCLUDED.authority_contact_id, contact_recipient_profile.authority_contact_id),
    default_payee_bank      = coalesce(EXCLUDED.default_payee_bank, contact_recipient_profile.default_payee_bank),
    default_payee_account   = coalesce(EXCLUDED.default_payee_account, contact_recipient_profile.default_payee_account),
    default_reference_template = coalesce(EXCLUDED.default_reference_template, contact_recipient_profile.default_reference_template),
    remittance_schedule_ref = coalesce(EXCLUDED.remittance_schedule_ref, contact_recipient_profile.remittance_schedule_ref),
    statement_cadence       = coalesce(EXCLUDED.statement_cadence, contact_recipient_profile.statement_cadence),
    jurisdiction_country    = coalesce(EXCLUDED.jurisdiction_country, contact_recipient_profile.jurisdiction_country),
    jurisdiction_region     = coalesce(EXCLUDED.jurisdiction_region, contact_recipient_profile.jurisdiction_region),
    always_first            = EXCLUDED.always_first,
    aggregate_cap_exempt    = EXCLUDED.aggregate_cap_exempt,
    is_active               = true,
    metadata                = contact_recipient_profile.metadata || coalesce(EXCLUDED.metadata, '{}'::jsonb),
    updated_at              = now();

  -- Legacy back-fill.
  SELECT id INTO v_legacy_id
    FROM public.legal_recipients
   WHERE organization_id = p_organization_id
     AND contact_id = v_contact_id
   LIMIT 1;

  IF v_legacy_id IS NULL THEN
    INSERT INTO public.legal_recipients(
      organization_id, contact_id, recipient_type_code, display_name,
      jurisdiction_country, jurisdiction_region, tax_id,
      contact_email, contact_phone,
      default_payee_bank, default_payee_account, default_payee_reference_template,
      remittance_schedule_ref, statement_cadence,
      always_first, aggregate_cap_exempt, is_active
    )
    VALUES (
      p_organization_id, v_contact_id,
      coalesce(nullif(btrim(p_recipient_type_code), ''), 'creditor'),
      btrim(p_name),
      nullif(btrim(p_jurisdiction_country), ''),
      nullif(btrim(p_jurisdiction_region), ''),
      nullif(btrim(p_tax_id), ''),
      nullif(btrim(p_email), ''),
      nullif(btrim(p_phone), ''),
      nullif(btrim(p_default_payee_bank), ''),
      nullif(btrim(p_default_payee_account), ''),
      nullif(btrim(p_default_reference_template), ''),
      nullif(btrim(p_remittance_schedule_ref), ''),
      nullif(btrim(p_statement_cadence), ''),
      coalesce(p_always_first, false),
      coalesce(p_aggregate_cap_exempt, false),
      true
    )
    RETURNING id INTO v_legacy_id;
  ELSE
    UPDATE public.legal_recipients SET
      recipient_type_code = coalesce(nullif(btrim(p_recipient_type_code), ''), recipient_type_code),
      display_name        = btrim(p_name),
      jurisdiction_country = coalesce(nullif(btrim(p_jurisdiction_country), ''), jurisdiction_country),
      jurisdiction_region  = coalesce(nullif(btrim(p_jurisdiction_region), ''), jurisdiction_region),
      tax_id               = coalesce(nullif(btrim(p_tax_id), ''), tax_id),
      contact_email        = coalesce(nullif(btrim(p_email), ''), contact_email),
      contact_phone        = coalesce(nullif(btrim(p_phone), ''), contact_phone),
      default_payee_bank   = coalesce(nullif(btrim(p_default_payee_bank), ''), default_payee_bank),
      default_payee_account = coalesce(nullif(btrim(p_default_payee_account), ''), default_payee_account),
      default_payee_reference_template = coalesce(nullif(btrim(p_default_reference_template), ''), default_payee_reference_template),
      remittance_schedule_ref = coalesce(nullif(btrim(p_remittance_schedule_ref), ''), remittance_schedule_ref),
      statement_cadence    = coalesce(nullif(btrim(p_statement_cadence), ''), statement_cadence),
      always_first         = coalesce(p_always_first, always_first),
      aggregate_cap_exempt = coalesce(p_aggregate_cap_exempt, aggregate_cap_exempt),
      is_active            = true
    WHERE id = v_legacy_id;
  END IF;

  RETURN jsonb_build_object(
    'contact_id',   v_contact_id,
    'recipient_id', v_legacy_id
  );
END $$;

GRANT EXECUTE ON FUNCTION public.party_upsert_recipient_from_form(
  uuid, uuid, uuid, text, boolean, text, text, text, text, text, text, text, text, text,
  text, uuid, text, text, text, text, text, text, text, boolean, boolean, jsonb
) TO authenticated;
