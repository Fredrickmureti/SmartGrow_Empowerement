
-- R5: Auto-provision legal_order_authorities from the pack's statutory_authorities
-- at install time. Enterprise tenants land with the jurisdiction's court /
-- tax / child-support / labor authorities pre-created, contact-backed, and
-- idempotent on (organization_id, code) so re-install is a no-op.

CREATE OR REPLACE FUNCTION public.install_legal_order_authorities_from_pack(
  p_organization_id uuid,
  p_pack_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pack_country text;
  v_default_business uuid;
  v_count integer := 0;
  r record;
  v_contact_id uuid;
  v_authority_type text;
  v_email text;
  v_phone text;
  v_address text;
BEGIN
  IF p_organization_id IS NULL OR p_pack_id IS NULL THEN
    RAISE EXCEPTION 'install_legal_order_authorities_from_pack: organization_id and pack_id are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT country_code INTO v_pack_country
    FROM public.localization_packs WHERE id = p_pack_id;

  -- Pick a stable business for the contact row (contacts are business-scoped).
  SELECT id INTO v_default_business
    FROM public.businesses
   WHERE organization_id = p_organization_id
   ORDER BY created_at ASC
   LIMIT 1;

  FOR r IN
    SELECT sa.code, sa.display_name, sa.portal_url, sa.contact, sa.country_code
      FROM public.statutory_authorities sa
     WHERE sa.pack_id = p_pack_id
  LOOP
    -- Classify authority_type from code / display_name heuristics. Falls back
    -- to 'statutory_body' — packs can override later via UI.
    v_authority_type := CASE
      WHEN r.code ILIKE '%court%'     OR r.display_name ILIKE '%court%'          THEN 'court'
      WHEN r.code ILIKE '%child%'     OR r.display_name ILIKE '%child support%'  THEN 'child_support_agency'
      WHEN r.code ILIKE '%labor%'     OR r.display_name ILIKE '%labour%'
                                       OR r.display_name ILIKE '%labor%'         THEN 'labor_ministry'
      WHEN r.code ILIKE '%tax%'       OR r.code ILIKE '%revenue%'
                                       OR r.display_name ILIKE '%revenue%'
                                       OR r.display_name ILIKE '%tax%'           THEN 'tax_agency'
      ELSE 'statutory_body'
    END;

    v_email   := NULLIF(r.contact->>'email', '');
    v_phone   := NULLIF(r.contact->>'phone', '');
    v_address := NULLIF(r.contact->>'address', '');

    -- Backing contact (business-scoped supplier). Idempotent on (business, name).
    v_contact_id := NULL;
    IF v_default_business IS NOT NULL THEN
      SELECT id INTO v_contact_id
        FROM public.contacts
       WHERE business_id = v_default_business
         AND lower(name) = lower(r.display_name)
       LIMIT 1;

      IF v_contact_id IS NULL THEN
        INSERT INTO public.contacts (
          organization_id, business_id, type, name, email, phone,
          address_line1, country, is_active
        ) VALUES (
          p_organization_id, v_default_business, 'supplier', r.display_name,
          v_email, v_phone, v_address, COALESCE(r.country_code, v_pack_country), true
        )
        RETURNING id INTO v_contact_id;
      END IF;
    END IF;

    INSERT INTO public.legal_order_authorities (
      organization_id, code, name, authority_type,
      jurisdiction_country, contact_email, contact_phone, address,
      contact_id, is_active, metadata
    ) VALUES (
      p_organization_id, r.code, r.display_name, v_authority_type,
      COALESCE(r.country_code, v_pack_country), v_email, v_phone, v_address,
      v_contact_id, true,
      jsonb_build_object('source_pack_id', p_pack_id, 'portal_url', r.portal_url)
    )
    ON CONFLICT (organization_id, code) DO UPDATE
      SET name                 = EXCLUDED.name,
          authority_type       = EXCLUDED.authority_type,
          jurisdiction_country = COALESCE(EXCLUDED.jurisdiction_country, public.legal_order_authorities.jurisdiction_country),
          contact_email        = COALESCE(EXCLUDED.contact_email, public.legal_order_authorities.contact_email),
          contact_phone        = COALESCE(EXCLUDED.contact_phone, public.legal_order_authorities.contact_phone),
          address              = COALESCE(EXCLUDED.address,       public.legal_order_authorities.address),
          contact_id           = COALESCE(public.legal_order_authorities.contact_id, EXCLUDED.contact_id),
          metadata             = public.legal_order_authorities.metadata
                                 || jsonb_build_object('source_pack_id', p_pack_id, 'portal_url', r.portal_url),
          updated_at           = now();

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.install_legal_order_authorities_from_pack(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.install_legal_order_authorities_from_pack(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.install_legal_order_authorities_from_pack IS
  'R5 (ADR-0093): idempotently provisions legal_order_authorities (with backing contacts) from statutory_authorities for the pack. Called at pack install so tenants land with the jurisdiction pre-loaded.';
