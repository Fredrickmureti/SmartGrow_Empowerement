
-- Identical to previous migration; only the lifecycle enum list in the view was wrong.

CREATE OR REPLACE FUNCTION public.upsert_statutory_override(
  p_business_id uuid,
  p_organization_id uuid,
  p_requirement_key text,
  p_country_code text,
  p_label text,
  p_help_text text,
  p_is_required boolean,
  p_blocks_onboarding boolean,
  p_blocks_payroll boolean,
  p_is_active boolean
)
RETURNS public.pack_requirements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_pack public.pack_requirements%ROWTYPE;
  v_existing public.pack_requirements%ROWTYPE;
  v_row public.pack_requirements%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.user_has_module_permission(v_caller, p_organization_id, 'hr', 'write') THEN
    RAISE EXCEPTION 'forbidden: hr.write required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_pack
  FROM public.pack_requirements
  WHERE business_id = p_business_id
    AND scope = 'statutory_identifier'
    AND requirement_key = p_requirement_key
    AND COALESCE(country_code, '') = COALESCE(p_country_code, '')
    AND source = 'pack'
  LIMIT 1;
  IF v_pack.id IS NULL THEN
    RAISE EXCEPTION 'no pack-published requirement matches % / %', p_requirement_key, COALESCE(p_country_code,'(global)')
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_existing
  FROM public.pack_requirements
  WHERE business_id = p_business_id
    AND scope = 'statutory_identifier'
    AND requirement_key = p_requirement_key
    AND COALESCE(country_code, '') = COALESCE(p_country_code, '')
    AND source = 'tenant_override'
  LIMIT 1;

  IF v_existing.id IS NULL THEN
    INSERT INTO public.pack_requirements(
      organization_id, business_id, pack_id, pack_version,
      scope, module, requirement_key, country_code,
      label, help_text, validation_regex, data_type,
      is_required, blocks_onboarding, blocks_payroll,
      applies_to_employment_types, sort_order, is_active,
      source, overrides_id
    ) VALUES (
      p_organization_id, p_business_id, v_pack.pack_id, v_pack.pack_version,
      'statutory_identifier', v_pack.module, p_requirement_key, p_country_code,
      COALESCE(NULLIF(p_label,''), v_pack.label),
      COALESCE(p_help_text, v_pack.help_text),
      v_pack.validation_regex,
      v_pack.data_type,
      COALESCE(p_is_required, v_pack.is_required),
      COALESCE(p_blocks_onboarding, v_pack.blocks_onboarding),
      COALESCE(p_blocks_payroll, v_pack.blocks_payroll),
      v_pack.applies_to_employment_types,
      v_pack.sort_order,
      COALESCE(p_is_active, true),
      'tenant_override',
      v_pack.id
    )
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.pack_requirements
       SET label              = COALESCE(NULLIF(p_label,''), v_pack.label),
           help_text          = COALESCE(p_help_text, v_pack.help_text),
           is_required        = COALESCE(p_is_required, v_existing.is_required),
           blocks_onboarding  = COALESCE(p_blocks_onboarding, v_existing.blocks_onboarding),
           blocks_payroll     = COALESCE(p_blocks_payroll, v_existing.blocks_payroll),
           is_active          = COALESCE(p_is_active, v_existing.is_active),
           overrides_id       = v_pack.id,
           validation_regex   = v_pack.validation_regex,
           data_type          = v_pack.data_type,
           updated_at         = now()
     WHERE id = v_existing.id
     RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_statutory_override(uuid,uuid,text,text,text,text,boolean,boolean,boolean,boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.upsert_statutory_override(uuid,uuid,text,text,text,text,boolean,boolean,boolean,boolean) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.reset_statutory_override(
  p_business_id uuid,
  p_organization_id uuid,
  p_requirement_key text,
  p_country_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.user_has_module_permission(v_caller, p_organization_id, 'hr', 'write') THEN
    RAISE EXCEPTION 'forbidden: hr.write required' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.pack_requirements
  WHERE business_id = p_business_id
    AND scope = 'statutory_identifier'
    AND requirement_key = p_requirement_key
    AND COALESCE(country_code, '') = COALESCE(p_country_code, '')
    AND source = 'tenant_override';
END;
$$;
REVOKE ALL ON FUNCTION public.reset_statutory_override(uuid,uuid,text,text) FROM public;
GRANT EXECUTE ON FUNCTION public.reset_statutory_override(uuid,uuid,text,text) TO authenticated, service_role;


-- View: past-draft employees (active operational set).
CREATE OR REPLACE VIEW public.employees_active
WITH (security_invoker = on)
AS
SELECT e.*
FROM public.employees e
WHERE e.lifecycle_status IN ('active','on_leave','notice','suspended');

GRANT SELECT ON public.employees_active TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.discard_stale_employee_drafts(
  p_business_id uuid,
  p_organization_id uuid,
  p_max_age_hours integer DEFAULT 24
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_count integer := 0;
  r record;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.user_has_module_permission(v_caller, p_organization_id, 'hr', 'write') THEN
    RAISE EXCEPTION 'forbidden: hr.write required' USING ERRCODE = '42501';
  END IF;
  FOR r IN
    SELECT id, first_name, last_name
    FROM public.employees
    WHERE organization_id = p_organization_id
      AND business_id = p_business_id
      AND lifecycle_status = 'draft'
      AND created_at < now() - make_interval(hours => GREATEST(p_max_age_hours, 0))
  LOOP
    DELETE FROM public.employees WHERE id = r.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.discard_stale_employee_drafts(uuid,uuid,integer) FROM public;
GRANT EXECUTE ON FUNCTION public.discard_stale_employee_drafts(uuid,uuid,integer) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.count_stale_employee_drafts(
  p_business_id uuid,
  p_organization_id uuid,
  p_max_age_hours integer DEFAULT 24
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::int
  FROM public.employees
  WHERE organization_id = p_organization_id
    AND business_id = p_business_id
    AND lifecycle_status = 'draft'
    AND created_at < now() - make_interval(hours => GREATEST(p_max_age_hours, 0));
$$;
REVOKE ALL ON FUNCTION public.count_stale_employee_drafts(uuid,uuid,integer) FROM public;
GRANT EXECUTE ON FUNCTION public.count_stale_employee_drafts(uuid,uuid,integer) TO authenticated, service_role;
