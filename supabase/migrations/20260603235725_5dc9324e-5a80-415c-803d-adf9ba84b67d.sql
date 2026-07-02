CREATE OR REPLACE FUNCTION public.convert_lead_to_contact(p_lead_id uuid)
RETURNS TABLE (id uuid, name text, was_existing boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_lead public.crm_leads%ROWTYPE;
  v_existing_id uuid;
  v_existing_name text;
  v_new_id uuid;
  v_new_name text;
BEGIN
  -- Lock the lead row for the duration of this tx so concurrent callers
  -- (e.g. a double-clicked "Convert" button) serialise on it.
  SELECT * INTO v_lead
  FROM public.crm_leads
  WHERE id = p_lead_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id USING ERRCODE = 'P0002';
  END IF;

  -- Idempotency: prefer contact_id, fall back to converted_to_contact_id.
  v_existing_id := COALESCE(v_lead.contact_id, v_lead.converted_to_contact_id);

  IF v_existing_id IS NOT NULL THEN
    SELECT c.name INTO v_existing_name
    FROM public.contacts c
    WHERE c.id = v_existing_id;

    IF v_existing_name IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_id, v_existing_name, true;
      RETURN;
    END IF;
    -- Linked contact was deleted; fall through and recreate.
  END IF;

  INSERT INTO public.contacts (
    organization_id, business_id, name, email, phone, company,
    type, notes, is_active
  ) VALUES (
    v_lead.organization_id,
    v_lead.business_id,
    COALESCE(NULLIF(v_lead.contact_name, ''), v_lead.name),
    NULLIF(v_lead.email, ''),
    NULLIF(v_lead.phone, ''),
    NULLIF(v_lead.company_name, ''),
    'customer',
    NULLIF(v_lead.description, ''),
    true
  )
  RETURNING contacts.id, contacts.name INTO v_new_id, v_new_name;

  UPDATE public.crm_leads
     SET contact_id = v_new_id,
         converted_to_contact_id = COALESCE(converted_to_contact_id, v_new_id),
         converted_at = COALESCE(converted_at, now())
   WHERE id = p_lead_id;

  RETURN QUERY SELECT v_new_id, v_new_name, false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.convert_lead_to_contact(uuid) TO authenticated;

COMMENT ON FUNCTION public.convert_lead_to_contact(uuid) IS
  'Idempotent lead → contact conversion. Locks the lead row, returns the existing linked contact if present, otherwise creates one and links it. Safe against double-click / retry duplicates.';