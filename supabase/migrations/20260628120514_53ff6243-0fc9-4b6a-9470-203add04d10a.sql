CREATE OR REPLACE FUNCTION public.create_employee_with_identifiers(p_employee jsonb, p_identifiers jsonb DEFAULT '[]'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid := NULLIF(p_employee->>'organization_id', '')::uuid;
  v_biz uuid := NULLIF(p_employee->>'business_id', '')::uuid;
  v_country text := upper(coalesce(p_employee->>'_country_code', ''));
  v_employee_id uuid;
  v_employee_number text;
  v_status text;
  v_row jsonb;
  v_key text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'organization_id required' USING ERRCODE = '23502';
  END IF;

  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'business_id required' USING ERRCODE = '23502';
  END IF;

  IF NOT public.user_has_module_permission(v_uid, v_org, v_biz, 'hr', 'create') THEN
    RAISE EXCEPTION 'permission denied: hr.create' USING ERRCODE = '42501';
  END IF;

  p_employee := p_employee - '_country_code';

  -- Form/RPC boundary: browsers and importers commonly send blank strings
  -- for unfilled optional controls. Convert those blanks to JSON null before
  -- jsonb_populate_record performs typed casts.
  FOR v_key IN SELECT k FROM jsonb_object_keys(p_employee) AS k LOOP
    IF jsonb_typeof(p_employee->v_key) = 'string' AND btrim(p_employee->>v_key) = '' THEN
      p_employee := jsonb_set(p_employee, ARRAY[v_key], 'null'::jsonb, false);
    END IF;
  END LOOP;

  v_employee_number := coalesce(
    NULLIF(p_employee->>'employee_number', ''),
    public.get_next_employee_number(v_org, v_biz)
  );

  v_status := coalesce(NULLIF(p_employee->>'lifecycle_status', ''), 'active');

  IF coalesce(btrim(p_employee->>'first_name'), '') = ''
     OR coalesce(btrim(p_employee->>'last_name'), '') = '' THEN
    RAISE EXCEPTION 'first and last name are required to create an employee'
      USING ERRCODE = 'P0001', HINT = 'employee_name_required';
  END IF;

  -- Active employee creation feeds lifecycle events, auto-employment, contract
  -- date validation, payroll readiness, and tenure reporting. Therefore the
  -- active creation contract requires an explicit hire_date. Drafts are the
  -- only exception: employees.hire_date is NOT NULL, so drafts receive a
  -- temporary date until finalize_employee_draft validates the real value.
  IF coalesce(NULLIF(p_employee->>'hire_date', ''), NULL) IS NULL THEN
    IF v_status = 'draft' THEN
      p_employee := p_employee || jsonb_build_object('hire_date', CURRENT_DATE::text);
    ELSE
      RAISE EXCEPTION 'hire date is required to create an active employee'
        USING ERRCODE = 'P0001', HINT = 'employee_hire_date_required';
    END IF;
  END IF;

  p_employee := p_employee || jsonb_build_object(
    'id',                 coalesce(NULLIF(p_employee->>'id', ''), gen_random_uuid()::text),
    'employee_number',    v_employee_number,
    'created_at',         coalesce(NULLIF(p_employee->>'created_at', ''), now()::text),
    'updated_at',         coalesce(NULLIF(p_employee->>'updated_at', ''), now()::text),
    'lifecycle_status',   v_status,
    'user_access_status', coalesce(NULLIF(p_employee->>'user_access_status', ''), 'none'),
    'sms_consent',        coalesce(p_employee->'sms_consent', to_jsonb(true)),
    'labor_burden_pct',   coalesce(p_employee->'labor_burden_pct', to_jsonb(0))
  );

  IF v_status = 'draft' THEN
    p_employee := p_employee || jsonb_build_object('draft_owner_id', v_uid::text);
  ELSE
    p_employee := p_employee - 'draft_owner_id';
  END IF;

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
$function$;