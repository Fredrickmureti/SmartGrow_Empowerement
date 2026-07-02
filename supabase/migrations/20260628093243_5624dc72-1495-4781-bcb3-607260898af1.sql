-- 1. Change kind enum
DO $$ BEGIN
  CREATE TYPE public.org_change_kind AS ENUM (
    'department_created',
    'department_renamed',
    'department_merged',
    'department_closed',
    'department_reopened',
    'position_created',
    'position_renamed',
    'position_closed',
    'location_created',
    'location_renamed',
    'location_closed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.org_entity_kind AS ENUM ('department','job_position','work_location');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Table
CREATE TABLE public.org_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  entity_kind public.org_entity_kind NOT NULL,
  entity_id uuid NOT NULL,
  change_kind public.org_change_kind NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  summary text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Grants
GRANT SELECT ON public.org_change_log TO authenticated;
GRANT ALL ON public.org_change_log TO service_role;

-- 4. RLS
ALTER TABLE public.org_change_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_change_log_select_org_members"
ON public.org_change_log
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid()
      AND uba.organization_id = org_change_log.organization_id
  )
);

-- No direct insert/update/delete policies — all writes go through SECURITY DEFINER RPCs.

-- 5. Indexes
CREATE INDEX idx_org_change_log_entity ON public.org_change_log (entity_kind, entity_id, occurred_at DESC);
CREATE INDEX idx_org_change_log_org_time ON public.org_change_log (organization_id, occurred_at DESC);

-- 6. RPC: rename department
CREATE OR REPLACE FUNCTION public.rename_department(
  p_department_id uuid,
  p_new_name text
) RETURNS public.org_change_log
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dept public.departments;
  v_old_name text;
  v_row public.org_change_log;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  SELECT * INTO v_dept FROM public.departments WHERE id = p_department_id;
  IF v_dept IS NULL THEN
    RAISE EXCEPTION 'Department not found: %', p_department_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.organization_id = v_dept.organization_id
  ) THEN
    RAISE EXCEPTION 'Not authorized for this organization';
  END IF;
  v_old_name := v_dept.name;
  UPDATE public.departments SET name = p_new_name, updated_at = now() WHERE id = p_department_id;

  INSERT INTO public.org_change_log (
    organization_id, business_id, entity_kind, entity_id, change_kind,
    actor_user_id, summary, payload
  ) VALUES (
    v_dept.organization_id, v_dept.business_id, 'department', p_department_id, 'department_renamed',
    auth.uid(), format('Renamed "%s" → "%s"', v_old_name, p_new_name),
    jsonb_build_object('from', v_old_name, 'to', p_new_name)
  ) RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- 7. RPC: merge department (reassign employees)
CREATE OR REPLACE FUNCTION public.merge_department(
  p_source_department_id uuid,
  p_target_department_id uuid
) RETURNS public.org_change_log
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src public.departments;
  v_tgt public.departments;
  v_count int;
  v_row public.org_change_log;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_source_department_id = p_target_department_id THEN
    RAISE EXCEPTION 'Source and target departments must differ';
  END IF;
  SELECT * INTO v_src FROM public.departments WHERE id = p_source_department_id;
  SELECT * INTO v_tgt FROM public.departments WHERE id = p_target_department_id;
  IF v_src IS NULL OR v_tgt IS NULL THEN
    RAISE EXCEPTION 'Source or target department not found';
  END IF;
  IF v_src.organization_id <> v_tgt.organization_id THEN
    RAISE EXCEPTION 'Cannot merge departments across organizations';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.organization_id = v_src.organization_id
  ) THEN
    RAISE EXCEPTION 'Not authorized for this organization';
  END IF;

  UPDATE public.employees
    SET department_id = p_target_department_id, updated_at = now()
    WHERE department_id = p_source_department_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Mark source as closed (soft) by setting is_active=false if column exists
  BEGIN
    EXECUTE 'UPDATE public.departments SET is_active = false, updated_at = now() WHERE id = $1'
      USING p_source_department_id;
  EXCEPTION WHEN undefined_column THEN
    NULL;
  END;

  INSERT INTO public.org_change_log (
    organization_id, business_id, entity_kind, entity_id, change_kind,
    actor_user_id, summary, payload
  ) VALUES (
    v_src.organization_id, v_src.business_id, 'department', p_source_department_id, 'department_merged',
    auth.uid(),
    format('Merged "%s" into "%s" (%s employees reassigned)', v_src.name, v_tgt.name, v_count),
    jsonb_build_object(
      'source_id', p_source_department_id, 'source_name', v_src.name,
      'target_id', p_target_department_id, 'target_name', v_tgt.name,
      'employees_reassigned', v_count
    )
  ) RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- 8. RPC: close department
CREATE OR REPLACE FUNCTION public.close_department(
  p_department_id uuid
) RETURNS public.org_change_log
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dept public.departments;
  v_active_count int;
  v_row public.org_change_log;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  SELECT * INTO v_dept FROM public.departments WHERE id = p_department_id;
  IF v_dept IS NULL THEN
    RAISE EXCEPTION 'Department not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.organization_id = v_dept.organization_id
  ) THEN
    RAISE EXCEPTION 'Not authorized for this organization';
  END IF;

  SELECT COUNT(*) INTO v_active_count
  FROM public.employees
  WHERE department_id = p_department_id
    AND COALESCE(is_archived, false) = false;

  IF v_active_count > 0 THEN
    RAISE EXCEPTION 'Cannot close department: % active employees still assigned. Reassign or merge first.', v_active_count;
  END IF;

  BEGIN
    EXECUTE 'UPDATE public.departments SET is_active = false, updated_at = now() WHERE id = $1'
      USING p_department_id;
  EXCEPTION WHEN undefined_column THEN
    NULL;
  END;

  INSERT INTO public.org_change_log (
    organization_id, business_id, entity_kind, entity_id, change_kind,
    actor_user_id, summary, payload
  ) VALUES (
    v_dept.organization_id, v_dept.business_id, 'department', p_department_id, 'department_closed',
    auth.uid(), format('Closed department "%s"', v_dept.name),
    jsonb_build_object('name', v_dept.name)
  ) RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.rename_department(uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.merge_department(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.close_department(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.rename_department(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.merge_department(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_department(uuid) TO authenticated, service_role;