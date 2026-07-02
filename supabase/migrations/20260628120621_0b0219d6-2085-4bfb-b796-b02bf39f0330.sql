CREATE OR REPLACE FUNCTION public.finalize_employee_draft(p_employee_id uuid, p_employee jsonb, p_identifiers jsonb DEFAULT '[]'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.employees%ROWTYPE;
  v_country text := upper(coalesce(p_employee->>'_country_code', ''));
  v_patch jsonb := p_employee - '_country_code'
                                - 'id'
                                - 'organization_id'
                                - 'business_id'
                                - 'lifecycle_status'
                                - 'draft_owner_id'
                                - 'created_at';
  v_merged jsonb;
  v_ident jsonb;
  v_types text[] := ARRAY[]::text[];
  v_key text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  -- Lock the row for the duration of the transaction.
  SELECT * INTO v_row FROM public.employees WHERE id = p_employee_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employee not found';
  END IF;

  -- Permission: same gate as creation (hr.create). Owner of the draft, the
  -- linked user, or anyone with hr.create on this org/business may finalize.
  IF NOT (
    v_row.draft_owner_id = v_uid
    OR v_row.user_id = v_uid
    OR public.user_has_module_permission(v_uid, v_row.organization_id, v_row.business_id, 'hr', 'create')
  ) THEN
    RAISE EXCEPTION 'permission denied: hr.create' USING ERRCODE = '42501';
  END IF;

  -- Idempotent: already active → just return.
  IF v_row.lifecycle_status <> 'draft' THEN
    RETURN v_row.id;
  END IF;

  -- Same RPC boundary rule as create_employee_with_identifiers: callers may
  -- send blank strings for unfilled form controls; database records need typed
  -- nulls before jsonb_populate_record casts the merged row.
  FOR v_key IN SELECT k FROM jsonb_object_keys(v_patch) AS k LOOP
    IF jsonb_typeof(v_patch->v_key) = 'string' AND btrim(v_patch->>v_key) = '' THEN
      v_patch := jsonb_set(v_patch, ARRAY[v_key], 'null'::jsonb, false);
    END IF;
  END LOOP;

  -- Merge the patch on top of the existing row, then validate required fields.
  v_merged := to_jsonb(v_row) || v_patch || jsonb_build_object(
    'lifecycle_status', 'active',
    'draft_owner_id',   NULL,
    'updated_at',       now()::text
  );

  IF coalesce(trim(v_merged->>'first_name'), '') = ''
     OR coalesce(trim(v_merged->>'last_name'), '') = '' THEN
    RAISE EXCEPTION 'first and last name are required to finalize an employee'
      USING ERRCODE = 'P0001', HINT = 'employee_name_required';
  END IF;

  IF coalesce(NULLIF(v_merged->>'hire_date', ''), NULL) IS NULL THEN
    RAISE EXCEPTION 'hire date is required to finalize an employee'
      USING ERRCODE = 'P0001', HINT = 'employee_hire_date_required';
  END IF;

  -- Apply the merged row via jsonb_populate_record so we don't have to enumerate columns.
  UPDATE public.employees AS e
     SET (
       first_name, last_name, email, phone, national_id, hire_date, termination_date,
       department_id, job_position_id, work_location_id, employment_type,
       bank_name, bank_branch, bank_account_number, bank_code,
       is_active, gender, date_of_birth, work_email, personal_phone,
       emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
       marital_status, address_line1, address_line2, city, county, postal_code, country,
       lifecycle_status, draft_owner_id, updated_at
     ) = (
       SELECT
         pr.first_name, pr.last_name, pr.email, pr.phone, pr.national_id, pr.hire_date, pr.termination_date,
         pr.department_id, pr.job_position_id, pr.work_location_id, pr.employment_type,
         pr.bank_name, pr.bank_branch, pr.bank_account_number, pr.bank_code,
         pr.is_active, pr.gender, pr.date_of_birth, pr.work_email, pr.personal_phone,
         pr.emergency_contact_name, pr.emergency_contact_phone, pr.emergency_contact_relationship,
         pr.marital_status, pr.address_line1, pr.address_line2, pr.city, pr.county, pr.postal_code, pr.country,
         'active'::text, NULL::uuid, now()
       FROM jsonb_populate_record(NULL::public.employees, v_merged) AS pr
     )
   WHERE e.id = p_employee_id;

  -- Statutory identifiers: replace the listed types (delete + insert non-empty).
  IF jsonb_typeof(p_identifiers) = 'array' AND jsonb_array_length(p_identifiers) > 0 THEN
    IF v_country = '' THEN
      RAISE EXCEPTION 'country_code required when persisting statutory identifiers';
    END IF;

    SELECT array_agg(elem->>'identifier_type')
      INTO v_types
      FROM jsonb_array_elements(p_identifiers) elem
     WHERE coalesce(elem->>'identifier_type','') <> '';

    IF v_types IS NOT NULL AND array_length(v_types, 1) > 0 THEN
      DELETE FROM public.employee_statutory_identifiers
       WHERE employee_id = p_employee_id
         AND identifier_type = ANY(v_types);
    END IF;

    FOR v_ident IN SELECT * FROM jsonb_array_elements(p_identifiers) LOOP
      IF coalesce(trim(v_ident->>'identifier_value'), '') = '' THEN
        CONTINUE;
      END IF;

      INSERT INTO public.employee_statutory_identifiers (
        employee_id, organization_id, business_id, country_code,
        identifier_type, identifier_value, is_active
      ) VALUES (
        p_employee_id, v_row.organization_id, v_row.business_id, v_country,
        v_ident->>'identifier_type', trim(v_ident->>'identifier_value'), true
      );
    END LOOP;
  END IF;

  RETURN p_employee_id;
END;
$function$;