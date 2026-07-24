
CREATE OR REPLACE FUNCTION public.legal_order_use_authority_as_recipient(
  p_order_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Prefer an existing contact-less recipient tied to this authority.
  SELECT id INTO v_recipient_id
    FROM public.legal_recipients
   WHERE organization_id = v_o.organization_id
     AND authority_id = v_a.id
     AND contact_id IS NULL
     AND recipient_type_code = v_type
     AND is_active
   LIMIT 1;

  -- If a recipient for this authority already exists but is contact-linked,
  -- refuse: require an explicit merge/pick from the existing dialog.
  IF v_recipient_id IS NULL AND EXISTS (
    SELECT 1 FROM public.legal_recipients
     WHERE organization_id = v_o.organization_id
       AND authority_id = v_a.id
       AND is_active
  ) THEN
    RAISE EXCEPTION 'MERGE_REQUIRED: another active recipient already exists for this authority — link the Contact instead' USING HINT='MERGE_REQUIRED';
  END IF;

  IF v_recipient_id IS NULL THEN
    INSERT INTO public.legal_recipients (
      organization_id, contact_id, authority_id, recipient_type_code,
      display_name, jurisdiction_country, jurisdiction_region,
      default_payee_bank, default_payee_account, default_payee_reference_template,
      contact_email, contact_phone, address,
      remittance_schedule_ref, aggregate_cap_exempt
    ) VALUES (
      v_o.organization_id, NULL, v_a.id, v_type,
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
  END IF;

  UPDATE public.legal_orders_records
     SET recipient_id = v_recipient_id,
         payee_name = COALESCE(payee_name, v_a.name),
         updated_at = now()
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'authority_id', v_a.id,
    'recipient_id', v_recipient_id,
    'recipient_type', v_type,
    'contact_id', NULL
  );
END
$$;

REVOKE ALL ON FUNCTION public.legal_order_use_authority_as_recipient(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_use_authority_as_recipient(uuid) TO authenticated;

COMMENT ON FUNCTION public.legal_order_use_authority_as_recipient(uuid) IS
  'Legal Orders UX gap fix: when an order already has an issuing authority (court/agency), let that authority act as the remittance recipient without requiring a separate Contact. Creates a contact-less legal_recipients row from the authority defaults and stamps legal_orders_records.recipient_id. Refuses with MERGE_REQUIRED when a contact-linked recipient already exists for the authority.';
