-- Wave 3: money integrity for projects.
-- A project's currency is the unit every budget, rate, timesheet value and
-- milestone amount is denominated in, so it must be a currency the business
-- actually trades in, and it must stop being editable once value exists.

CREATE OR REPLACE FUNCTION public._project_assert_currency(
  _organization_id uuid,
  _business_id uuid,
  _currency text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_currency text := NULLIF(btrim(upper(_currency)), '');
  v_base text;
BEGIN
  IF v_currency IS NULL THEN
    RETURN; -- inherits the business base currency downstream
  END IF;

  IF _business_id IS NULL THEN
    -- Org-level project: fall back to the global currency catalogue.
    IF NOT EXISTS (SELECT 1 FROM public.currencies c WHERE upper(c.code) = v_currency) THEN
      RAISE EXCEPTION 'Currency % is not a recognised currency', v_currency
        USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;

  SELECT upper(b.base_currency) INTO v_base
  FROM public.businesses b
  WHERE b.id = _business_id;

  IF v_currency = v_base THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.business_active_currencies bac
    WHERE bac.business_id = _business_id
      AND upper(bac.currency_code) = v_currency
      AND coalesce(bac.is_enabled, true)
  ) THEN
    RAISE EXCEPTION 'Currency % is not enabled for this business', v_currency
      USING ERRCODE = '22023';
  END IF;
END;
$$;

-- True once the project carries recorded value: switching the currency or the
-- billing model afterwards would silently reinterpret existing amounts.
CREATE OR REPLACE FUNCTION public._project_has_financial_activity(_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.timesheets t WHERE t.project_id = _project_id)
      OR EXISTS (
           SELECT 1 FROM public.project_milestones m
           WHERE m.project_id = _project_id AND coalesce(m.is_reached, false)
         );
$$;

CREATE OR REPLACE FUNCTION public.project_update_config(_project_id uuid, _patch jsonb)
RETURNS projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_locked CONSTANT text[] := ARRAY['currency','pricing_type','is_billable'];
  v_new_currency text;
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

  -- Currency must be one the business trades in.
  IF _patch ? 'currency' THEN
    v_new_currency := NULLIF(btrim(upper(_patch->>'currency')), '');
    PERFORM public._project_assert_currency(v_row.organization_id, v_row.business_id, v_new_currency);
  END IF;

  -- Money-model lock: once time or reached milestones exist, the unit and the
  -- billing model are history and cannot be reinterpreted.
  IF public._project_has_financial_activity(_project_id) THEN
    FOREACH v_key IN ARRAY v_locked LOOP
      IF _patch ? v_key THEN
        IF v_key = 'currency'
           AND coalesce(v_new_currency, upper(v_row.currency)) IS NOT DISTINCT FROM upper(v_row.currency) THEN
          CONTINUE; -- no-op resubmit of the same value
        END IF;
        IF v_key = 'pricing_type'
           AND coalesce(NULLIF(_patch->>'pricing_type',''), v_row.pricing_type) IS NOT DISTINCT FROM v_row.pricing_type THEN
          CONTINUE;
        END IF;
        IF v_key = 'is_billable'
           AND coalesce((_patch->>'is_billable')::boolean, v_row.is_billable) IS NOT DISTINCT FROM v_row.is_billable THEN
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'Cannot change % once the project has recorded time or reached milestones', v_key
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
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
    currency = CASE WHEN _patch ? 'currency' THEN coalesce(v_new_currency, p.currency) ELSE p.currency END,
    budget = CASE WHEN _patch ? 'budget' THEN NULLIF(_patch->>'budget','')::numeric ELSE p.budget END,
    budget_type = CASE WHEN _patch ? 'budget_type' THEN coalesce(NULLIF(_patch->>'budget_type',''), p.budget_type) ELSE p.budget_type END,
    hourly_rate = CASE WHEN _patch ? 'hourly_rate' THEN NULLIF(_patch->>'hourly_rate','')::numeric ELSE p.hourly_rate END,
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
$function$;

-- Templates are org-shared but business-scoped data; instantiating one is a
-- write against the target project, so it needs the same authority check.
CREATE OR REPLACE FUNCTION public.apply_project_template(_template_id uuid, _project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_t public.project_templates;
  v_p public.projects;
  v_stage jsonb;
  v_ms jsonb;
  v_task jsonb;
  v_count_stages int := 0;
  v_count_milestones int := 0;
  v_count_tasks int := 0;
BEGIN
  SELECT * INTO v_t FROM public.project_templates WHERE id = _template_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'template_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_p FROM public.projects WHERE id = _project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002'; END IF;

  IF v_p.organization_id <> v_t.organization_id THEN
    RAISE EXCEPTION 'org_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_t.business_id IS NOT NULL AND v_p.business_id IS DISTINCT FROM v_t.business_id THEN
    RAISE EXCEPTION 'This template belongs to a different business' USING ERRCODE = '42501';
  END IF;
  IF coalesce(v_t.is_active, true) = false THEN
    RAISE EXCEPTION 'This template is no longer active' USING ERRCODE = '42501';
  END IF;

  -- Called from project_create (creator is already a manager member) and
  -- directly from the UI; in both cases the caller must be able to write.
  IF v_uid IS NULL OR NOT public.project_can_write(_project_id, v_uid) THEN
    RAISE EXCEPTION 'Not allowed to apply a template to this project' USING ERRCODE = '42501';
  END IF;

  FOR v_stage IN SELECT * FROM jsonb_array_elements(coalesce(v_t.default_stages, '[]'::jsonb))
  LOOP
    INSERT INTO public.project_stages (organization_id, project_id, name, color, sequence, is_closed)
    VALUES (
      v_p.organization_id, v_p.id,
      v_stage->>'name',
      v_stage->>'color',
      coalesce((v_stage->>'sequence')::int, v_count_stages * 10),
      coalesce((v_stage->>'is_closed')::boolean, false)
    );
    v_count_stages := v_count_stages + 1;
  END LOOP;

  FOR v_ms IN SELECT * FROM jsonb_array_elements(coalesce(v_t.default_milestones, '[]'::jsonb))
  LOOP
    INSERT INTO public.project_milestones (organization_id, project_id, name, description, target_date)
    VALUES (
      v_p.organization_id, v_p.id,
      v_ms->>'name', v_ms->>'description',
      NULLIF(v_ms->>'target_date','')::date
    );
    v_count_milestones := v_count_milestones + 1;
  END LOOP;

  FOR v_task IN SELECT * FROM jsonb_array_elements(coalesce(v_t.default_tasks, '[]'::jsonb))
  LOOP
    INSERT INTO public.project_tasks (organization_id, project_id, name, description, planned_hours, priority)
    VALUES (
      v_p.organization_id, v_p.id,
      v_task->>'name', v_task->>'description',
      NULLIF(v_task->>'planned_hours','')::numeric,
      coalesce((v_task->>'priority')::int, 0)
    );
    v_count_tasks := v_count_tasks + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'stages', v_count_stages,
    'milestones', v_count_milestones,
    'tasks', v_count_tasks
  );
END;
$function$;

-- Creation path: validate the currency before the row exists.
CREATE OR REPLACE FUNCTION public.project_create(_payload jsonb)
RETURNS projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid := NULLIF(_payload->>'organization_id','')::uuid;
  v_business uuid := NULLIF(_payload->>'business_id','')::uuid;
  v_branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  v_number text;
  v_rate numeric := NULLIF(_payload->>'hourly_rate','')::numeric;
  v_template uuid := NULLIF(_payload->>'template_id','')::uuid;
  v_currency text := NULLIF(btrim(upper(_payload->>'currency')), '');
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

  PERFORM public._project_assert_currency(v_org, v_business, v_currency);

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
      v_currency,
      (SELECT upper(b.base_currency) FROM public.businesses b WHERE b.id = v_business)
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
$function$;

REVOKE ALL ON FUNCTION public._project_assert_currency(uuid, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public._project_has_financial_activity(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public._project_has_financial_activity(uuid) TO authenticated;