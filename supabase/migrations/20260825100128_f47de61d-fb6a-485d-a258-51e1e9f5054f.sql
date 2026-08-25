-- =====================================================================
-- Wave 1 — Projects: server-side authority & access control
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Access helpers
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.project_is_governor(_project_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = _project_id
      AND (
        public.has_role(_user_id, p.organization_id, 'super_admin'::public.app_role)
        OR public.has_role(_user_id, p.organization_id, 'owner'::public.app_role)
        OR public.has_role(_user_id, p.organization_id, 'admin'::public.app_role)
        OR p.manager_id = _user_id
      )
  );
$$;

COMMENT ON FUNCTION public.project_is_governor(uuid, uuid) IS
  'True when the user governs the project (org admin/owner or the project manager). Governors may change billing configuration, manager, privacy and branch.';

CREATE OR REPLACE FUNCTION public.project_can_read(_project_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = _project_id
      AND public.user_has_module_permission(_user_id, p.organization_id, 'projects', 'read')
      AND public.user_can_access_branch(_user_id, p.branch_id)
      AND (
        public.project_is_governor(p.id, _user_id)
        OR p.privacy = 'public'
        OR p.created_by = _user_id
        OR public.is_project_member(p.id, _user_id)
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.project_can_write(_project_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = _project_id
      AND public.user_has_module_permission(_user_id, p.organization_id, 'projects', 'write')
      AND public.user_can_access_branch(_user_id, p.branch_id)
      AND (
        public.project_is_governor(p.id, _user_id)
        OR p.created_by = _user_id
        OR public.is_project_member(p.id, _user_id)
      )
  );
$$;

COMMENT ON FUNCTION public.project_can_write(uuid, uuid) IS
  'Write authority mirrors read visibility: module permission + branch access + governor/creator/member. Prevents editing a project the caller cannot see.';

CREATE OR REPLACE FUNCTION public.project_can_delete(_project_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = _project_id
      AND public.user_has_module_permission(_user_id, p.organization_id, 'projects', 'delete')
      AND public.user_can_access_branch(_user_id, p.branch_id)
      AND (public.project_is_governor(p.id, _user_id) OR p.created_by = _user_id)
  );
$$;

-- ---------------------------------------------------------------------
-- 2. RLS: projects
-- ---------------------------------------------------------------------

DROP POLICY IF EXISTS projects_select_perm ON public.projects;
DROP POLICY IF EXISTS projects_insert_perm ON public.projects;
DROP POLICY IF EXISTS projects_update_perm ON public.projects;
DROP POLICY IF EXISTS projects_delete_perm ON public.projects;

CREATE POLICY projects_select_perm ON public.projects
  FOR SELECT TO authenticated
  USING (public.project_can_read(id, auth.uid()));

CREATE POLICY projects_insert_perm ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_has_module_permission(auth.uid(), organization_id, 'projects', 'create')
    AND public.is_org_member(auth.uid(), organization_id)
    AND public.user_can_access_branch(auth.uid(), branch_id)
  );

CREATE POLICY projects_update_perm ON public.projects
  FOR UPDATE TO authenticated
  USING (public.project_can_write(id, auth.uid()))
  WITH CHECK (public.project_can_write(id, auth.uid()));

CREATE POLICY projects_delete_perm ON public.projects
  FOR DELETE TO authenticated
  USING (public.project_can_delete(id, auth.uid()));

-- ---------------------------------------------------------------------
-- 3. RLS: child tables — write requires project write authority
-- ---------------------------------------------------------------------

-- project_stages
DROP POLICY IF EXISTS project_stages_select_perm ON public.project_stages;
DROP POLICY IF EXISTS project_stages_insert_perm ON public.project_stages;
DROP POLICY IF EXISTS project_stages_update_perm ON public.project_stages;
DROP POLICY IF EXISTS project_stages_delete_perm ON public.project_stages;

CREATE POLICY project_stages_select_perm ON public.project_stages
  FOR SELECT TO authenticated USING (public.project_can_read(project_id, auth.uid()));
CREATE POLICY project_stages_insert_perm ON public.project_stages
  FOR INSERT TO authenticated WITH CHECK (public.project_can_write(project_id, auth.uid()));
CREATE POLICY project_stages_update_perm ON public.project_stages
  FOR UPDATE TO authenticated
  USING (public.project_can_write(project_id, auth.uid()))
  WITH CHECK (public.project_can_write(project_id, auth.uid()));
CREATE POLICY project_stages_delete_perm ON public.project_stages
  FOR DELETE TO authenticated USING (public.project_can_write(project_id, auth.uid()));

-- project_milestones
DROP POLICY IF EXISTS project_milestones_select_perm ON public.project_milestones;
DROP POLICY IF EXISTS project_milestones_insert_perm ON public.project_milestones;
DROP POLICY IF EXISTS project_milestones_update_perm ON public.project_milestones;
DROP POLICY IF EXISTS project_milestones_delete_perm ON public.project_milestones;

CREATE POLICY project_milestones_select_perm ON public.project_milestones
  FOR SELECT TO authenticated USING (public.project_can_read(project_id, auth.uid()));
CREATE POLICY project_milestones_insert_perm ON public.project_milestones
  FOR INSERT TO authenticated WITH CHECK (public.project_can_write(project_id, auth.uid()));
CREATE POLICY project_milestones_update_perm ON public.project_milestones
  FOR UPDATE TO authenticated
  USING (public.project_can_write(project_id, auth.uid()))
  WITH CHECK (public.project_can_write(project_id, auth.uid()));
CREATE POLICY project_milestones_delete_perm ON public.project_milestones
  FOR DELETE TO authenticated USING (public.project_can_write(project_id, auth.uid()));

-- project_tasks (keeps the customer-portal read path)
DROP POLICY IF EXISTS project_tasks_select_perm ON public.project_tasks;
DROP POLICY IF EXISTS project_tasks_insert_perm ON public.project_tasks;
DROP POLICY IF EXISTS project_tasks_update_perm ON public.project_tasks;
DROP POLICY IF EXISTS project_tasks_delete_perm ON public.project_tasks;

CREATE POLICY project_tasks_select_perm ON public.project_tasks
  FOR SELECT TO authenticated USING (public.project_can_read(project_id, auth.uid()));
CREATE POLICY project_tasks_insert_perm ON public.project_tasks
  FOR INSERT TO authenticated WITH CHECK (public.project_can_write(project_id, auth.uid()));
CREATE POLICY project_tasks_update_perm ON public.project_tasks
  FOR UPDATE TO authenticated
  USING (public.project_can_write(project_id, auth.uid()))
  WITH CHECK (public.project_can_write(project_id, auth.uid()));
CREATE POLICY project_tasks_delete_perm ON public.project_tasks
  FOR DELETE TO authenticated USING (public.project_can_write(project_id, auth.uid()));

-- project_members
DROP POLICY IF EXISTS project_members_select ON public.project_members;
DROP POLICY IF EXISTS project_members_insert ON public.project_members;
DROP POLICY IF EXISTS project_members_update ON public.project_members;
DROP POLICY IF EXISTS project_members_delete ON public.project_members;

CREATE POLICY project_members_select ON public.project_members
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.project_can_read(project_id, auth.uid()));
CREATE POLICY project_members_insert ON public.project_members
  FOR INSERT TO authenticated WITH CHECK (public.project_is_governor(project_id, auth.uid()));
CREATE POLICY project_members_update ON public.project_members
  FOR UPDATE TO authenticated
  USING (public.project_is_governor(project_id, auth.uid()))
  WITH CHECK (public.project_is_governor(project_id, auth.uid()));
CREATE POLICY project_members_delete ON public.project_members
  FOR DELETE TO authenticated USING (public.project_is_governor(project_id, auth.uid()));

-- project_documents (align with the same authority model)
DROP POLICY IF EXISTS "Project access reads documents" ON public.project_documents;
DROP POLICY IF EXISTS "Project access inserts documents" ON public.project_documents;
DROP POLICY IF EXISTS "Project access updates documents" ON public.project_documents;
DROP POLICY IF EXISTS "Project access deletes documents" ON public.project_documents;

CREATE POLICY project_documents_select ON public.project_documents
  FOR SELECT TO authenticated USING (public.project_can_read(project_id, auth.uid()));
CREATE POLICY project_documents_insert ON public.project_documents
  FOR INSERT TO authenticated WITH CHECK (public.project_can_write(project_id, auth.uid()));
CREATE POLICY project_documents_update ON public.project_documents
  FOR UPDATE TO authenticated
  USING (public.project_can_write(project_id, auth.uid()))
  WITH CHECK (public.project_can_write(project_id, auth.uid()));
CREATE POLICY project_documents_delete ON public.project_documents
  FOR DELETE TO authenticated USING (public.project_can_write(project_id, auth.uid()));

-- ---------------------------------------------------------------------
-- 4. Server-side command functions
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.project_create(_payload jsonb)
RETURNS public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid := NULLIF(_payload->>'organization_id','')::uuid;
  v_business uuid := NULLIF(_payload->>'business_id','')::uuid;
  v_branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  v_number text;
  v_rate numeric := NULLIF(_payload->>'hourly_rate','')::numeric;
  v_template uuid := NULLIF(_payload->>'template_id','')::uuid;
  v_row public.projects;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'organization_id is required' USING ERRCODE = '22023';
  END IF;

  PERFORM public._assert_org_member(v_org);

  IF NOT public.user_has_module_permission(v_uid, v_org, 'projects', 'create') THEN
    RAISE EXCEPTION 'Not allowed to create projects' USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_can_access_branch(v_uid, v_branch) THEN
    RAISE EXCEPTION 'Not allowed to create projects in this branch' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(_payload->>'name'), '') = '' THEN
    RAISE EXCEPTION 'Project name is required' USING ERRCODE = '22023';
  END IF;

  v_number := public.get_next_project_number(v_org);

  INSERT INTO public.projects (
    organization_id, business_id, branch_id, project_number,
    name, description, status, project_type,
    start_date, end_date, color, allocated_hours, priority,
    budget, budget_type, hourly_rate, default_billable_rate,
    is_billable, allow_timesheets, privacy, tags,
    customer_id, manager_id, created_by,
    pricing_type, currency, template_id, is_template,
    source_lead_id, source_sales_order_id
  ) VALUES (
    v_org, v_business, v_branch, v_number,
    btrim(_payload->>'name'),
    NULLIF(_payload->>'description',''),
    coalesce(NULLIF(_payload->>'status',''), 'active'),
    coalesce(NULLIF(_payload->>'project_type',''), 'internal'),
    NULLIF(_payload->>'start_date','')::date,
    NULLIF(_payload->>'end_date','')::date,
    coalesce(NULLIF(_payload->>'color',''), '#3b82f6'),
    NULLIF(_payload->>'allocated_hours','')::numeric,
    coalesce(NULLIF(_payload->>'priority','')::int, 0),
    NULLIF(_payload->>'budget','')::numeric,
    coalesce(NULLIF(_payload->>'budget_type',''), 'none'),
    v_rate,
    v_rate,
    coalesce((_payload->>'is_billable')::boolean, false),
    coalesce((_payload->>'allow_timesheets')::boolean, true),
    coalesce(NULLIF(_payload->>'privacy',''), 'team'),
    CASE WHEN _payload ? 'tags' AND jsonb_typeof(_payload->'tags') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(_payload->'tags')) END,
    NULLIF(_payload->>'customer_id','')::uuid,
    NULLIF(_payload->>'manager_id','')::uuid,
    v_uid,
    coalesce(NULLIF(_payload->>'pricing_type',''), 'non_billable'),
    coalesce(
      NULLIF(_payload->>'currency',''),
      (SELECT b.base_currency FROM public.businesses b WHERE b.id = v_business)
    ),
    v_template,
    coalesce((_payload->>'is_template')::boolean, false),
    NULLIF(_payload->>'source_lead_id','')::uuid,
    NULLIF(_payload->>'source_sales_order_id','')::uuid
  )
  RETURNING * INTO v_row;

  INSERT INTO public.project_members (project_id, user_id, role)
  VALUES (v_row.id, v_uid, 'manager')
  ON CONFLICT DO NOTHING;

  IF v_row.manager_id IS NOT NULL AND v_row.manager_id <> v_uid THEN
    INSERT INTO public.project_members (project_id, user_id, role)
    VALUES (v_row.id, v_row.manager_id, 'manager')
    ON CONFLICT DO NOTHING;
  END IF;

  IF v_template IS NOT NULL THEN
    PERFORM public.apply_project_template(v_template, v_row.id);
  ELSE
    INSERT INTO public.project_stages (organization_id, project_id, name, sequence, is_closed)
    VALUES
      (v_org, v_row.id, 'To Do', 0, false),
      (v_org, v_row.id, 'In Progress', 1, false),
      (v_org, v_row.id, 'Review', 2, false),
      (v_org, v_row.id, 'Done', 3, true);
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.project_create(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.project_create(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.project_update_config(_project_id uuid, _patch jsonb)
RETURNS public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.projects;
  v_key text;
  v_governed CONSTANT text[] := ARRAY[
    'pricing_type','currency','budget','budget_type','hourly_rate',
    'default_billable_rate','is_billable','allow_timesheets',
    'manager_id','privacy','branch_id','customer_id','project_type'
  ];
  v_allowed CONSTANT text[] := v_governed || ARRAY[
    'name','description','color','priority','tags',
    'start_date','end_date','allocated_hours','margin_alert_threshold'
  ];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.projects WHERE id = _project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.project_can_write(_project_id, v_uid) THEN
    RAISE EXCEPTION 'Not allowed to modify this project' USING ERRCODE = '42501';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(_patch) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'Field % cannot be changed through project_update_config', v_key
        USING ERRCODE = '42501';
    END IF;
    IF v_key = ANY (v_governed) AND NOT public.project_is_governor(_project_id, v_uid) THEN
      RAISE EXCEPTION 'Only an administrator or the project manager can change %', v_key
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF _patch ? 'branch_id'
     AND NOT public.user_can_access_branch(v_uid, NULLIF(_patch->>'branch_id','')::uuid) THEN
    RAISE EXCEPTION 'Not allowed to move this project to that branch' USING ERRCODE = '42501';
  END IF;

  UPDATE public.projects p SET
    name = CASE WHEN _patch ? 'name' THEN btrim(_patch->>'name') ELSE p.name END,
    description = CASE WHEN _patch ? 'description' THEN NULLIF(_patch->>'description','') ELSE p.description END,
    color = CASE WHEN _patch ? 'color' THEN coalesce(NULLIF(_patch->>'color',''), p.color) ELSE p.color END,
    priority = CASE WHEN _patch ? 'priority' THEN coalesce(NULLIF(_patch->>'priority','')::int, p.priority) ELSE p.priority END,
    tags = CASE WHEN _patch ? 'tags' THEN
             CASE WHEN jsonb_typeof(_patch->'tags') = 'array'
                  THEN ARRAY(SELECT jsonb_array_elements_text(_patch->'tags')) END
           ELSE p.tags END,
    start_date = CASE WHEN _patch ? 'start_date' THEN NULLIF(_patch->>'start_date','')::date ELSE p.start_date END,
    end_date = CASE WHEN _patch ? 'end_date' THEN NULLIF(_patch->>'end_date','')::date ELSE p.end_date END,
    allocated_hours = CASE WHEN _patch ? 'allocated_hours' THEN NULLIF(_patch->>'allocated_hours','')::numeric ELSE p.allocated_hours END,
    margin_alert_threshold = CASE WHEN _patch ? 'margin_alert_threshold' THEN NULLIF(_patch->>'margin_alert_threshold','')::numeric ELSE p.margin_alert_threshold END,
    pricing_type = CASE WHEN _patch ? 'pricing_type' THEN coalesce(NULLIF(_patch->>'pricing_type',''), p.pricing_type) ELSE p.pricing_type END,
    currency = CASE WHEN _patch ? 'currency' THEN coalesce(NULLIF(_patch->>'currency',''), p.currency) ELSE p.currency END,
    budget = CASE WHEN _patch ? 'budget' THEN NULLIF(_patch->>'budget','')::numeric ELSE p.budget END,
    budget_type = CASE WHEN _patch ? 'budget_type' THEN coalesce(NULLIF(_patch->>'budget_type',''), p.budget_type) ELSE p.budget_type END,
    hourly_rate = CASE WHEN _patch ? 'hourly_rate' THEN NULLIF(_patch->>'hourly_rate','')::numeric ELSE p.hourly_rate END,
    -- Single rate source of truth: default_billable_rate always follows hourly_rate
    -- unless it is explicitly set in the same patch.
    default_billable_rate = CASE
      WHEN _patch ? 'default_billable_rate' THEN NULLIF(_patch->>'default_billable_rate','')::numeric
      WHEN _patch ? 'hourly_rate' THEN NULLIF(_patch->>'hourly_rate','')::numeric
      ELSE p.default_billable_rate END,
    is_billable = CASE WHEN _patch ? 'is_billable' THEN coalesce((_patch->>'is_billable')::boolean, p.is_billable) ELSE p.is_billable END,
    allow_timesheets = CASE WHEN _patch ? 'allow_timesheets' THEN coalesce((_patch->>'allow_timesheets')::boolean, p.allow_timesheets) ELSE p.allow_timesheets END,
    manager_id = CASE WHEN _patch ? 'manager_id' THEN NULLIF(_patch->>'manager_id','')::uuid ELSE p.manager_id END,
    privacy = CASE WHEN _patch ? 'privacy' THEN coalesce(NULLIF(_patch->>'privacy',''), p.privacy) ELSE p.privacy END,
    branch_id = CASE WHEN _patch ? 'branch_id' THEN NULLIF(_patch->>'branch_id','')::uuid ELSE p.branch_id END,
    customer_id = CASE WHEN _patch ? 'customer_id' THEN NULLIF(_patch->>'customer_id','')::uuid ELSE p.customer_id END,
    project_type = CASE WHEN _patch ? 'project_type' THEN coalesce(NULLIF(_patch->>'project_type',''), p.project_type) ELSE p.project_type END,
    updated_at = now()
  WHERE p.id = _project_id
  RETURNING * INTO v_row;

  IF v_row.manager_id IS NOT NULL THEN
    INSERT INTO public.project_members (project_id, user_id, role)
    VALUES (v_row.id, v_row.manager_id, 'manager')
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.project_update_config(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.project_update_config(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.project_change_status(_project_id uuid, _status text)
RETURNS public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.projects;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF _status NOT IN ('draft','active','on_hold','completed','cancelled') THEN
    RAISE EXCEPTION 'Unknown project status %', _status USING ERRCODE = '22023';
  END IF;
  IF NOT public.project_is_governor(_project_id, v_uid) THEN
    RAISE EXCEPTION 'Only an administrator or the project manager can change project status'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.projects p SET
    status = _status,
    actual_start_date = CASE
      WHEN _status = 'active' AND p.actual_start_date IS NULL THEN CURRENT_DATE
      ELSE p.actual_start_date END,
    actual_end_date = CASE
      WHEN _status IN ('completed','cancelled') THEN coalesce(p.actual_end_date, CURRENT_DATE)
      ELSE NULL END,
    updated_at = now()
  WHERE p.id = _project_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.project_change_status(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.project_change_status(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.project_add_member(_project_id uuid, _user_id uuid, _role text DEFAULT 'member', _billable_rate numeric DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_is_governor(_project_id, v_uid) THEN
    RAISE EXCEPTION 'Only an administrator or the project manager can manage the project team'
      USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_org FROM public.projects WHERE id = _project_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_org_member(_user_id, v_org) THEN
    RAISE EXCEPTION 'That user is not a member of this organization' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.project_members (project_id, user_id, role, billable_rate)
  VALUES (_project_id, _user_id, coalesce(NULLIF(_role,''), 'member'), _billable_rate)
  ON CONFLICT (project_id, user_id)
  DO UPDATE SET role = EXCLUDED.role, billable_rate = EXCLUDED.billable_rate;
END;
$$;

REVOKE ALL ON FUNCTION public.project_add_member(uuid, uuid, text, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.project_add_member(uuid, uuid, text, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.project_remove_member(_project_id uuid, _user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_manager uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_is_governor(_project_id, v_uid) THEN
    RAISE EXCEPTION 'Only an administrator or the project manager can manage the project team'
      USING ERRCODE = '42501';
  END IF;

  SELECT manager_id INTO v_manager FROM public.projects WHERE id = _project_id;
  IF v_manager = _user_id THEN
    RAISE EXCEPTION 'Reassign the project manager before removing them from the team'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.project_members WHERE project_id = _project_id AND user_id = _user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.project_remove_member(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.project_remove_member(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.project_archive(_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_can_delete(_project_id, v_uid) THEN
    RAISE EXCEPTION 'Not allowed to archive this project' USING ERRCODE = '42501';
  END IF;

  UPDATE public.projects
     SET is_active = false, updated_at = now()
   WHERE id = _project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.project_archive(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.project_archive(uuid) TO authenticated;