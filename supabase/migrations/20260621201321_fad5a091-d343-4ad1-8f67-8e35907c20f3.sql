
-- Stage 3: server-side employee draft lifecycle
-- (a) record who owns the draft so it stays private to its author
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS draft_owner_id uuid NULL;

CREATE INDEX IF NOT EXISTS idx_employees_org_lifecycle
  ON public.employees (organization_id, lifecycle_status);

CREATE INDEX IF NOT EXISTS idx_employees_draft_owner
  ON public.employees (draft_owner_id) WHERE lifecycle_status = 'draft';

-- (b) restrictive RLS so drafts only show to their author, the linked user,
--     or HR users with write/manage permission on the org+business.
DROP POLICY IF EXISTS employees_draft_visibility ON public.employees;
CREATE POLICY employees_draft_visibility
  ON public.employees
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (
    lifecycle_status <> 'draft'
    OR draft_owner_id = auth.uid()
    OR user_id = auth.uid()
    OR public.user_has_module_permission(
         auth.uid(), organization_id, business_id, 'hr', 'write'
       )
  );

-- (c) RPC: stamp draft_owner_id when a row is inserted as a draft.
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
  v_status text;
  v_row jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'organization_id required'; END IF;

  IF NOT public.user_has_module_permission(v_uid, v_org, v_biz, 'hr', 'create') THEN
    RAISE EXCEPTION 'permission denied: hr.create' USING ERRCODE='42501';
  END IF;

  p_employee := p_employee - '_country_code';

  v_employee_number := coalesce(
    NULLIF(p_employee->>'employee_number', ''),
    public.get_next_employee_number(v_org, v_biz)
  );

  v_status := coalesce(NULLIF(p_employee->>'lifecycle_status', ''), 'active');

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

  -- Stamp draft_owner_id only when the row is created as a draft.
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

-- (d) promote-to-active RPC: validates required fields and flips draft → active.
CREATE OR REPLACE FUNCTION public.promote_employee_draft(p_employee_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.employees%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_row FROM public.employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'employee not found'; END IF;
  IF v_row.lifecycle_status <> 'draft' THEN
    RETURN; -- already promoted; idempotent
  END IF;
  IF NOT public.user_has_module_permission(v_uid, v_row.organization_id, v_row.business_id, 'hr', 'write') THEN
    RAISE EXCEPTION 'permission denied: hr.write' USING ERRCODE='42501';
  END IF;
  IF coalesce(trim(v_row.first_name), '') = '' OR coalesce(trim(v_row.last_name), '') = '' THEN
    RAISE EXCEPTION 'first and last name are required to promote a draft';
  END IF;
  IF v_row.hire_date IS NULL THEN
    RAISE EXCEPTION 'hire date is required to promote a draft';
  END IF;
  UPDATE public.employees
     SET lifecycle_status = 'active',
         draft_owner_id   = NULL,
         updated_at       = now()
   WHERE id = p_employee_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.promote_employee_draft(uuid) TO authenticated;
