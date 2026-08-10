CREATE OR REPLACE FUNCTION public._assert_party_address_contact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_contact_id uuid;
  v_business_id uuid;
  v_row jsonb := to_jsonb(NEW);
BEGIN
  IF TG_TABLE_NAME = 'bills' THEN
    v_contact_id := NULLIF(v_row->>'remit_to_contact_id','')::uuid;
  ELSE
    v_contact_id := NULLIF(v_row->>'bill_to_contact_id','')::uuid;
  END IF;

  IF v_contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT business_id INTO v_business_id
  FROM public.contacts
  WHERE id = v_contact_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Address party % does not exist', v_contact_id
      USING ERRCODE = '23503';
  END IF;

  IF v_business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'Address party % belongs to a different business', v_contact_id
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;