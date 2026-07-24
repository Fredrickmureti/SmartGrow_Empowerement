-- Phase 7 Step 0: Recipient linking RPCs.
-- The garnishment order base table is public.legal_orders_records; public.garnishments
-- is not a physical table in this project.

CREATE OR REPLACE FUNCTION public.legal_recipient_link_contact(
  p_recipient_id uuid,
  p_contact_id uuid,
  p_copy_defaults boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec public.legal_recipients%ROWTYPE;
  v_contact public.contacts%ROWTYPE;
  v_uid uuid := auth.uid();
  v_conflict uuid;
BEGIN
  SELECT * INTO v_rec FROM public.legal_recipients WHERE id = p_recipient_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'recipient not found' USING HINT='NOT_FOUND'; END IF;

  SELECT * INTO v_contact FROM public.contacts WHERE id = p_contact_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'contact not found' USING HINT='NOT_FOUND'; END IF;

  IF v_contact.organization_id <> v_rec.organization_id THEN
    RAISE EXCEPTION 'contact and recipient belong to different organizations' USING HINT='ORG_MISMATCH';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = v_uid AND uba.organization_id = v_rec.organization_id
  ) THEN
    RAISE EXCEPTION 'not a member of the organization' USING HINT='PERMISSION_DENIED', ERRCODE='42501';
  END IF;

  SELECT id INTO v_conflict
    FROM public.legal_recipients
   WHERE organization_id = v_rec.organization_id
     AND contact_id = p_contact_id
     AND recipient_type_code = v_rec.recipient_type_code
     AND COALESCE(jurisdiction_country,'') = COALESCE(v_rec.jurisdiction_country,'')
     AND COALESCE(jurisdiction_region,'')  = COALESCE(v_rec.jurisdiction_region,'')
     AND is_active
     AND id <> p_recipient_id
   LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'another active recipient is already linked to this contact for the same type/jurisdiction — merge instead (source=%, target=%)',
      p_recipient_id, v_conflict
      USING HINT='MERGE_REQUIRED';
  END IF;

  UPDATE public.legal_recipients
     SET contact_id = p_contact_id,
         display_name = CASE
           WHEN display_name IS NULL OR btrim(display_name) = '' OR display_name = 'Recipient'
           THEN COALESCE(v_contact.name, display_name)
           ELSE display_name
         END,
         contact_email = CASE WHEN p_copy_defaults AND contact_email IS NULL THEN v_contact.email ELSE contact_email END,
         contact_phone = CASE WHEN p_copy_defaults AND contact_phone IS NULL THEN v_contact.phone ELSE contact_phone END,
         address       = CASE WHEN p_copy_defaults AND address IS NULL THEN
                              NULLIF(concat_ws(', ', v_contact.address_line1, v_contact.address_line2, v_contact.city, v_contact.country), '')
                              ELSE address END,
         jurisdiction_country = COALESCE(jurisdiction_country, v_contact.country),
         updated_at = now()
   WHERE id = p_recipient_id;

  -- Stamp orders that reference this recipient but had no payee_contact_id.
  UPDATE public.legal_orders_records
     SET payee_contact_id = p_contact_id,
         updated_at = now()
   WHERE recipient_id = p_recipient_id
     AND payee_contact_id IS NULL;

  RETURN jsonb_build_object(
    'recipient_id', p_recipient_id,
    'contact_id', p_contact_id,
    'linked_at', now()
  );
END
$$;

REVOKE ALL ON FUNCTION public.legal_recipient_link_contact(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_recipient_link_contact(uuid, uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.legal_recipient_link_contact(uuid, uuid, boolean) IS
  'Phase 7.0: link a legal_recipients row to a Contact so remittance/bank-file generation can proceed. Copies contact defaults into null fields; refuses when a duplicate identity already exists (merge instead).';


CREATE OR REPLACE FUNCTION public.legal_order_attach_contact(
  p_order_id uuid,
  p_contact_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o public.legal_orders_records%ROWTYPE;
  v_contact public.contacts%ROWTYPE;
  v_type text;
  v_recipient_id uuid;
  v_kind_text text;
  v_uid uuid := auth.uid();
BEGIN
  SELECT * INTO v_o FROM public.legal_orders_records WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'legal order not found' USING HINT='NOT_FOUND'; END IF;

  SELECT * INTO v_contact FROM public.contacts WHERE id = p_contact_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'contact not found' USING HINT='NOT_FOUND'; END IF;

  IF v_contact.organization_id <> v_o.organization_id THEN
    RAISE EXCEPTION 'contact and order belong to different organizations' USING HINT='ORG_MISMATCH';
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

  SELECT id INTO v_recipient_id
    FROM public.legal_recipients
   WHERE organization_id = v_o.organization_id
     AND contact_id = p_contact_id
     AND recipient_type_code = v_type
     AND COALESCE(jurisdiction_country,'') = COALESCE(v_contact.country,'')
     AND is_active
   LIMIT 1;

  IF v_recipient_id IS NULL THEN
    INSERT INTO public.legal_recipients (
      organization_id, contact_id, recipient_type_code,
      display_name, jurisdiction_country,
      default_payee_bank, default_payee_account, default_payee_reference_template,
      default_payment_method_id, aggregate_cap_exempt,
      contact_email, contact_phone, address
    ) VALUES (
      v_o.organization_id, p_contact_id, v_type,
      COALESCE(v_contact.name, v_o.payee_name, 'Recipient'),
      v_contact.country,
      v_o.payee_bank, v_o.payee_account, v_o.payee_reference,
      v_o.payee_payment_method_id, COALESCE(v_o.aggregate_cap_exempt, false),
      v_contact.email, v_contact.phone,
      NULLIF(concat_ws(', ', v_contact.address_line1, v_contact.address_line2, v_contact.city, v_contact.country), '')
    )
    RETURNING id INTO v_recipient_id;
  END IF;

  UPDATE public.legal_orders_records
     SET payee_contact_id = p_contact_id,
         payee_name = COALESCE(payee_name, v_contact.name),
         recipient_id = v_recipient_id,
         updated_at = now()
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'contact_id', p_contact_id,
    'recipient_id', v_recipient_id,
    'recipient_type', v_type
  );
END
$$;

REVOKE ALL ON FUNCTION public.legal_order_attach_contact(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_attach_contact(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.legal_order_attach_contact(uuid, uuid) IS
  'Phase 7.0: resolve the "recipient not linked" badge on a legal order. Attaches a Contact to the order, then finds or creates the matching legal_recipients identity and stamps legal_orders_records.recipient_id.';
