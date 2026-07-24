
-- 1. Add contact_id column + FK + uniqueness
ALTER TABLE public.legal_order_authorities
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS legal_order_authorities_contact_uidx
  ON public.legal_order_authorities(organization_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- 2. Trigger fn: ensure a party-only contact exists for the authority
CREATE OR REPLACE FUNCTION public.legal_order_authority_ensure_contact()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id uuid;
  v_existing_contact uuid;
BEGIN
  IF NEW.contact_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Reuse an existing party-only contact with the same name in this org, if any.
  SELECT id INTO v_existing_contact
    FROM public.contacts
   WHERE organization_id = NEW.organization_id
     AND lower(name) = lower(NEW.name)
     AND customer_rank = 0
     AND supplier_rank = 0
   LIMIT 1;

  IF v_existing_contact IS NOT NULL THEN
    NEW.contact_id := v_existing_contact;
    RETURN NEW;
  END IF;

  -- Pick any active business in the org to satisfy the NOT NULL constraint.
  SELECT id INTO v_business_id
    FROM public.businesses
   WHERE organization_id = NEW.organization_id
   ORDER BY created_at ASC
   LIMIT 1;

  IF v_business_id IS NULL THEN
    -- No business yet — leave contact_id NULL, will be provisioned later.
    RETURN NEW;
  END IF;

  INSERT INTO public.contacts (
    organization_id, business_id, name, email, phone, country,
    is_company, is_active, customer_rank, supplier_rank, type
  ) VALUES (
    NEW.organization_id, v_business_id, NEW.name,
    NEW.contact_email, NEW.contact_phone, NEW.jurisdiction_country,
    true, true, 0, 0, 'customer' -- type is NOT NULL; rank 0/0 keeps it party-only
  )
  RETURNING id INTO NEW.contact_id;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_legal_order_authority_ensure_contact ON public.legal_order_authorities;
CREATE TRIGGER trg_legal_order_authority_ensure_contact
  BEFORE INSERT OR UPDATE OF contact_id, name, organization_id
  ON public.legal_order_authorities
  FOR EACH ROW
  EXECUTE FUNCTION public.legal_order_authority_ensure_contact();

-- 3. Backfill existing authorities
DO $$
DECLARE
  r RECORD;
  v_business_id uuid;
  v_contact_id uuid;
BEGIN
  FOR r IN
    SELECT * FROM public.legal_order_authorities WHERE contact_id IS NULL
  LOOP
    SELECT id INTO v_contact_id
      FROM public.contacts
     WHERE organization_id = r.organization_id
       AND lower(name) = lower(r.name)
       AND customer_rank = 0
       AND supplier_rank = 0
     LIMIT 1;

    IF v_contact_id IS NULL THEN
      SELECT id INTO v_business_id
        FROM public.businesses
       WHERE organization_id = r.organization_id
       ORDER BY created_at ASC
       LIMIT 1;

      IF v_business_id IS NULL THEN
        CONTINUE;
      END IF;

      INSERT INTO public.contacts (
        organization_id, business_id, name, email, phone, country,
        is_company, is_active, customer_rank, supplier_rank, type
      ) VALUES (
        r.organization_id, v_business_id, r.name,
        r.contact_email, r.contact_phone, r.jurisdiction_country,
        true, true, 0, 0, 'customer'
      )
      RETURNING id INTO v_contact_id;
    END IF;

    UPDATE public.legal_order_authorities
       SET contact_id = v_contact_id
     WHERE id = r.id;
  END LOOP;
END
$$;

-- 4. Update legal_order_use_authority_as_recipient RPC to stamp contact_id
CREATE OR REPLACE FUNCTION public.legal_order_use_authority_as_recipient(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_o public.legal_orders_records%ROWTYPE;
  v_a public.legal_order_authorities%ROWTYPE;
  v_type text;
  v_kind_text text;
  v_recipient_id uuid;
  v_uid uuid := auth.uid();
BEGIN
  SELECT * INTO v_o FROM public.legal_orders_records WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'legal order not found' USING HINT='NOT_FOUND'; END IF;

  IF v_o.authority_id IS NULL THEN
    RAISE EXCEPTION 'legal order has no issuing authority set' USING HINT='NO_AUTHORITY';
  END IF;

  SELECT * INTO v_a FROM public.legal_order_authorities WHERE id = v_o.authority_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'issuing authority not found' USING HINT='NOT_FOUND'; END IF;

  IF v_a.organization_id <> v_o.organization_id THEN
    RAISE EXCEPTION 'authority and order belong to different organizations' USING HINT='ORG_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = v_uid AND uba.organization_id = v_o.organization_id
  ) THEN
    RAISE EXCEPTION 'not a member of the organization' USING HINT='PERMISSION_DENIED', ERRCODE='42501';
  END IF;

  v_kind_text := v_o.kind::text;
  v_type := CASE v_kind_text
    WHEN 'child_support'    THEN 'child_support_agency'
    WHEN 'tax_levy'         THEN 'tax_authority'
    WHEN 'court_order'      THEN 'court'
    WHEN 'creditor'         THEN 'creditor'
    WHEN 'student_loan'     THEN 'creditor'
    WHEN 'wage_assignment'  THEN 'creditor'
    WHEN 'alimony'          THEN 'child_support_agency'
    WHEN 'medical_support'  THEN 'child_support_agency'
    WHEN 'bankruptcy_order' THEN 'court'
    WHEN 'sacco_loan'       THEN 'creditor'
    WHEN 'union_dues'       THEN 'creditor'
    ELSE 'other'
  END;

  -- Prefer an existing active recipient for this authority (contact-linked or not).
  SELECT id INTO v_recipient_id
    FROM public.legal_recipients
   WHERE organization_id = v_o.organization_id
     AND authority_id = v_a.id
     AND is_active
   ORDER BY (contact_id IS NULL) DESC, created_at ASC
   LIMIT 1;

  IF v_recipient_id IS NULL THEN
    INSERT INTO public.legal_recipients (
      organization_id, contact_id, authority_id, recipient_type_code,
      display_name, jurisdiction_country, jurisdiction_region,
      default_payee_bank, default_payee_account, default_payee_reference_template,
      contact_email, contact_phone, address,
      remittance_schedule_ref, aggregate_cap_exempt
    ) VALUES (
      v_o.organization_id, v_a.contact_id, v_a.id, v_type,
      COALESCE(v_a.name, v_o.payee_name, 'Recipient'),
      v_a.jurisdiction_country, v_a.jurisdiction_region,
      COALESCE(v_o.payee_bank, v_a.default_payee_bank),
      COALESCE(v_o.payee_account, v_a.default_payee_account),
      COALESCE(v_o.payee_reference, v_a.default_payee_reference_template),
      v_a.contact_email, v_a.contact_phone, v_a.address,
      v_a.remittance_schedule_ref,
      COALESCE(v_o.aggregate_cap_exempt, false)
    )
    RETURNING id INTO v_recipient_id;
  ELSE
    -- Upgrade the recipient with the authority's contact if missing.
    UPDATE public.legal_recipients
       SET contact_id = COALESCE(contact_id, v_a.contact_id),
           updated_at = now()
     WHERE id = v_recipient_id;
  END IF;

  UPDATE public.legal_orders_records
     SET recipient_id = v_recipient_id,
         payee_contact_id = COALESCE(payee_contact_id, v_a.contact_id),
         payee_name = COALESCE(payee_name, v_a.name),
         updated_at = now()
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'authority_id', v_a.id,
    'recipient_id', v_recipient_id,
    'recipient_type', v_type,
    'contact_id', v_a.contact_id
  );
END
$function$;
