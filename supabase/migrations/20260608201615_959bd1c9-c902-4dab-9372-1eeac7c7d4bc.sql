
CREATE OR REPLACE FUNCTION public.create_employee_with_identifiers(
  p_employee jsonb,
  p_identifiers jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid := (p_employee->>'organization_id')::uuid;
  v_biz uuid := NULLIF(p_employee->>'business_id', '')::uuid;
  v_country text := upper(coalesce(p_employee->>'_country_code', ''));
  v_employee_id uuid;
  v_row jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'organization_id required'; END IF;

  IF NOT public.user_has_module_permission(v_uid, v_org, v_biz, 'hr', 'create') THEN
    RAISE EXCEPTION 'permission denied: hr.create' USING ERRCODE='42501';
  END IF;

  -- Strip transient keys before inserting.
  p_employee := p_employee - '_country_code';

  INSERT INTO public.employees
  SELECT * FROM jsonb_populate_record(NULL::public.employees, p_employee)
  RETURNING id INTO v_employee_id;

  IF jsonb_typeof(p_identifiers) = 'array' AND jsonb_array_length(p_identifiers) > 0 THEN
    IF v_country = '' THEN
      RAISE EXCEPTION 'country_code required when persisting statutory identifiers';
    END IF;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_identifiers) LOOP
      IF coalesce(trim(v_row->>'identifier_value'), '') = '' THEN
        CONTINUE;
      END IF;
      INSERT INTO public.employee_statutory_identifiers (
        employee_id, organization_id, business_id, country_code,
        identifier_type, identifier_value, is_active
      ) VALUES (
        v_employee_id, v_org, v_biz, v_country,
        v_row->>'identifier_type', trim(v_row->>'identifier_value'), true
      );
    END LOOP;
  END IF;

  RETURN v_employee_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_employee_with_identifiers(jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_employee_with_identifiers(jsonb, jsonb) TO service_role;
