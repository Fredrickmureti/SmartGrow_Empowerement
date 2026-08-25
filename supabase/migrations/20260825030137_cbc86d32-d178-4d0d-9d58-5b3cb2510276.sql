-- The lifecycle guard exists to stop *users* editing a closed lead's customer or
-- value. The conversion path is a trusted system write: winning a lead and then
-- converting it (win -> customer -> sales order) is the normal sequence, and it
-- was aborting on the very bookkeeping the converter itself performs.
-- Announce the write with the same `app.crm_lead_writer` flag the crm_* transition
-- functions use, so the guard keeps refusing hand edits while the converter works.
CREATE OR REPLACE FUNCTION public.convert_lead_to_contact(p_lead_id uuid)
 RETURNS TABLE(id uuid, name text, was_existing boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lead public.crm_leads%ROWTYPE;
  v_existing_id uuid;
  v_existing_name text;
  v_new_id uuid;
  v_new_name text;
  v_company_id uuid;
BEGIN
  v_lead := public._crm_assert_lead_access(p_lead_id, 'create');

  SELECT * INTO v_lead
    FROM public.crm_leads WHERE crm_leads.id = p_lead_id FOR UPDATE;

  v_existing_id := COALESCE(v_lead.contact_id, v_lead.converted_to_contact_id);
  IF v_existing_id IS NOT NULL THEN
    SELECT c.name INTO v_existing_name FROM public.contacts c WHERE c.id = v_existing_id;
    IF v_existing_name IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_id, v_existing_name, true;
      RETURN;
    END IF;
  END IF;

  v_company_id := v_lead.company_contact_id;
  -- A company contact from another business must never be adopted as parent.
  IF v_company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.id = v_company_id AND c.business_id = v_lead.business_id
  ) THEN
    RAISE EXCEPTION 'CRM: company contact % does not belong to business %',
      v_company_id, v_lead.business_id USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.contacts (
    organization_id, business_id, name, email, phone,
    type, notes, is_active, is_company,
    parent_contact_id, commercial_partner_id
  ) VALUES (
    v_lead.organization_id, v_lead.business_id,
    COALESCE(NULLIF(v_lead.contact_name, ''), v_lead.name),
    NULLIF(v_lead.email, ''), NULLIF(v_lead.phone, ''),
    'customer', NULLIF(v_lead.description, ''), true, false,
    v_company_id, v_company_id
  )
  RETURNING contacts.id, contacts.name INTO v_new_id, v_new_name;

  -- Trusted system write: links the customer just created to the lead. Only
  -- these three conversion columns change; nothing lifecycle-related is touched.
  PERFORM set_config('app.crm_lead_writer', '1', true);
  UPDATE public.crm_leads
     SET contact_id              = v_new_id,
         converted_to_contact_id = COALESCE(converted_to_contact_id, v_new_id),
         converted_at            = COALESCE(converted_at, now())
   WHERE crm_leads.id = p_lead_id;
  PERFORM set_config('app.crm_lead_writer', '0', true);

  INSERT INTO public.crm_activities (
    organization_id, business_id, lead_id, activity_type, summary,
    is_done, completed_at, created_by
  ) VALUES (
    v_lead.organization_id, v_lead.business_id, p_lead_id, 'system',
    'Lead converted to contact: ' || v_new_name, true, now(), auth.uid()
  );

  RETURN QUERY SELECT v_new_id, v_new_name, false;
END;
$function$;