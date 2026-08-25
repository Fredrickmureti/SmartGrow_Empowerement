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
    'manager_id','privacy','branch_id','customer_id','project_type',
    'allows_cross_branch_work','time_entry_open_to_org'
  ];
  v_allowed CONSTANT text[] := v_governed || ARRAY[
    'name','description','color','priority','tags',
    'start_date','end_date','allocated_hours','margin_alert_threshold'
  ];
  v_locked CONSTANT text[] := ARRAY['currency','pricing_type','is_billable','branch_id'];
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

  IF _patch ? 'currency' THEN
    v_new_currency := NULLIF(btrim(upper(_patch->>'currency')), '');
    PERFORM public._project_assert_currency(v_row.organization_id, v_row.business_id, v_new_currency);
  END IF;

  IF public._project_has_financial_activity(_project_id) THEN
    FOREACH v_key IN ARRAY v_locked LOOP
      IF _patch ? v_key THEN
        IF v_key = 'currency'
           AND coalesce(v_new_currency, upper(v_row.currency)) IS NOT DISTINCT FROM upper(v_row.currency) THEN
          CONTINUE;
        END IF;
        IF v_key = 'pricing_type'
           AND coalesce(NULLIF(_patch->>'pricing_type',''), v_row.pricing_type) IS NOT DISTINCT FROM v_row.pricing_type THEN
          CONTINUE;
        END IF;
        IF v_key = 'is_billable'
           AND coalesce((_patch->>'is_billable')::boolean, v_row.is_billable) IS NOT DISTINCT FROM v_row.is_billable THEN
          CONTINUE;
        END IF;
        IF v_key = 'branch_id'
           AND NULLIF(_patch->>'branch_id','')::uuid IS NOT DISTINCT FROM v_row.branch_id THEN
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
    allows_cross_branch_work = CASE WHEN _patch ? 'allows_cross_branch_work'
      THEN coalesce((_patch->>'allows_cross_branch_work')::boolean, p.allows_cross_branch_work)
      ELSE p.allows_cross_branch_work END,
    time_entry_open_to_org = CASE WHEN _patch ? 'time_entry_open_to_org'
      THEN coalesce((_patch->>'time_entry_open_to_org')::boolean, p.time_entry_open_to_org)
      ELSE p.time_entry_open_to_org END,
    manager_id = CASE WHEN _patch ? 'manager_id' THEN NULLIF(_patch->>'manager_id','')::uuid ELSE p.manager_id END,
    privacy = CASE WHEN _patch ? 'privacy' THEN coalesce(NULLIF(_patch->>'privacy',''), p.privacy) ELSE p.privacy END,
    branch_id = CASE WHEN _patch ? 'branch_id' THEN NULLIF(_patch->>'branch_id','')::uuid ELSE p.branch_id END,
    customer_id = CASE WHEN _patch ? 'customer_id' THEN NULLIF(_patch->>'customer_id','')::uuid ELSE p.customer_id END,
    project_type = CASE WHEN _patch ? 'project_type' THEN coalesce(NULLIF(_patch->>'project_type',''), p.project_type) ELSE p.project_type END,
    updated_at = now()
  WHERE p.id = _project_id
  RETURNING * INTO v_row;

  IF v_row.manager_id IS NOT NULL THEN
    INSERT INTO public.project_members (project_id, user_id, role, project_role, can_write, is_billable_participant)
    VALUES (v_row.id, v_row.manager_id, 'manager', 'manager', true, true)
    ON CONFLICT (project_id, user_id) DO UPDATE
      SET role = 'manager', project_role = 'manager', can_write = true;
  END IF;

  RETURN v_row;
END;
$function$;