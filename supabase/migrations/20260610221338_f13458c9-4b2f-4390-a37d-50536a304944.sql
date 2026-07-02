-- Fix create_employee_with_identifiers: stop NULL-stomping defaults via jsonb_populate_record,
-- and add a BEFORE INSERT defensive trigger on public.employees that backfills
-- managed columns (id, employee_number, timestamps, lifecycle defaults) so no
-- insertion path can ever leave them NULL.

CREATE OR REPLACE FUNCTION public.create_employee_with_identifiers(
  p_employee jsonb,
  p_identifiers jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid := (p_employee->>'organization_id')::uuid;
  v_biz uuid := NULLIF(p_employee->>'business_id', '')::uuid;
  v_country text := upper(coalesce(p_employee->>'_country_code', ''));
  v_employee_id uuid;
  v_employee_number text;
  v_row jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'organization_id required'; END IF;

  IF NOT public.user_has_module_permission(v_uid, v_org, v_biz, 'hr', 'create') THEN
    RAISE EXCEPTION 'permission denied: hr.create' USING ERRCODE='42501';
  END IF;

  -- Strip transient keys before inserting.
  p_employee := p_employee - '_country_code';

  -- Allocate employee_number atomically per business (advisory-locked inside).
  v_employee_number := coalesce(
    NULLIF(p_employee->>'employee_number', ''),
    public.get_next_employee_number(v_org, v_biz)
  );

  -- Backfill managed columns. jsonb_populate_record + INSERT SELECT * sends
  -- explicit NULLs to Postgres for every missing key, which bypasses column
  -- DEFAULT clauses. We must hydrate them here so the row is valid.
  p_employee := p_employee || jsonb_build_object(
    'id',                 coalesce(NULLIF(p_employee->>'id', ''), gen_random_uuid()::text),
    'employee_number',    v_employee_number,
    'created_at',         coalesce(NULLIF(p_employee->>'created_at', ''), now()::text),
    'updated_at',         coalesce(NULLIF(p_employee->>'updated_at', ''), now()::text),
    'lifecycle_status',   coalesce(NULLIF(p_employee->>'lifecycle_status', ''), 'draft'),
    'user_access_status', coalesce(NULLIF(p_employee->>'user_access_status', ''), 'none'),
    'sms_consent',        coalesce(p_employee->'sms_consent', to_jsonb(true)),
    'labor_burden_pct',   coalesce(p_employee->'labor_burden_pct', to_jsonb(0))
  );

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

-- Defense-in-depth: BEFORE INSERT trigger so any future insertion path
-- (admin scripts, migrations, alternate RPCs) cannot land NULLs in
-- managed columns.
CREATE OR REPLACE FUNCTION public.employees_fill_managed_defaults()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := gen_random_uuid();
  END IF;
  IF NEW.created_at IS NULL THEN
    NEW.created_at := now();
  END IF;
  IF NEW.updated_at IS NULL THEN
    NEW.updated_at := now();
  END IF;
  IF NEW.lifecycle_status IS NULL THEN
    NEW.lifecycle_status := 'draft';
  END IF;
  IF NEW.user_access_status IS NULL THEN
    NEW.user_access_status := 'none';
  END IF;
  IF NEW.sms_consent IS NULL THEN
    NEW.sms_consent := true;
  END IF;
  IF NEW.labor_burden_pct IS NULL THEN
    NEW.labor_burden_pct := 0;
  END IF;
  IF NEW.employee_number IS NULL OR NEW.employee_number = '' THEN
    NEW.employee_number := public.get_next_employee_number(NEW.organization_id, NEW.business_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employees_fill_managed_defaults_biu ON public.employees;
CREATE TRIGGER employees_fill_managed_defaults_biu
BEFORE INSERT ON public.employees
FOR EACH ROW EXECUTE FUNCTION public.employees_fill_managed_defaults();