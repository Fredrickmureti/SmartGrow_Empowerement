-- ============================================================
-- Wave 3 item 3: one billing-rate engine
-- ============================================================
CREATE OR REPLACE FUNCTION public.resolve_project_billing_rate(
  _project_id uuid,
  _employee_id uuid DEFAULT NULL,
  _explicit numeric DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _explicit,
    (SELECT pm.billable_rate
       FROM public.project_members pm
       JOIN public.employees e ON e.id = _employee_id
      WHERE pm.project_id = _project_id
        AND pm.user_id = e.user_id
      LIMIT 1),
    (SELECT COALESCE(p.default_billable_rate, p.hourly_rate)
       FROM public.projects p WHERE p.id = _project_id)
  )::numeric;
$function$;

COMMENT ON FUNCTION public.resolve_project_billing_rate(uuid, uuid, numeric) IS
  'Single billing-rate precedence chain for project time: explicit entry rate -> project_members.billable_rate for the employee -> projects.default_billable_rate (falling back to projects.hourly_rate for legacy rows). Every consumer (timesheet trigger, resolve_timesheet_billing_rate, UI preview) must delegate here.';

-- Timesheet trigger delegates instead of mirroring projects.hourly_rate.
CREATE OR REPLACE FUNCTION public.trg_timesheets_billing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_rate numeric; v_project_billable boolean;
BEGIN
  IF NEW.is_billable THEN
    IF NEW.project_id IS NULL THEN RAISE EXCEPTION 'Billable time requires a project'; END IF;
    SELECT p.is_billable INTO v_project_billable
      FROM public.projects p WHERE p.id = NEW.project_id;
    IF v_project_billable IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Project is not billable'; END IF;
    v_rate := public.resolve_project_billing_rate(NEW.project_id, NEW.employee_id, NEW.billing_rate);
    IF v_rate IS NULL OR v_rate <= 0 THEN RAISE EXCEPTION 'No billing rate configured for project'; END IF;
    NEW.billing_rate := v_rate;
    NEW.billing_amount := ROUND((COALESCE(NEW.hours,0) * v_rate)::numeric, 2);
  ELSE
    NEW.billing_rate := NULL;
    NEW.billing_amount := NULL;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.resolve_timesheet_billing_rate(_timesheet_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    public.resolve_project_billing_rate(t.project_id, t.employee_id, t.billing_rate),
    0
  )::numeric
  FROM public.timesheets t
  WHERE t.id = _timesheet_id
  LIMIT 1
$function$;

-- Authorized preview so the UI never mirrors the chain client-side.
CREATE OR REPLACE FUNCTION public.project_billing_rate_preview(
  _project_id uuid,
  _employee_id uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.project_can_read(_project_id, v_uid) THEN
    RAISE EXCEPTION 'Not allowed to read this project' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(public.resolve_project_billing_rate(_project_id, _employee_id, NULL), 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.project_billing_rate_preview(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_billing_rate_preview(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.resolve_project_billing_rate(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_project_billing_rate(uuid, uuid, numeric) TO authenticated, service_role;

-- ============================================================
-- Wave 3 item 4: branch is part of the money model once time exists
-- ============================================================
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

  -- Currency must be one the business trades in.
  IF _patch ? 'currency' THEN
    v_new_currency := NULLIF(btrim(upper(_patch->>'currency')), '');
    PERFORM public._project_assert_currency(v_row.organization_id, v_row.business_id, v_new_currency);
  END IF;

  -- Money-model lock: once time or reached milestones exist, the unit, the
  -- billing model and the owning branch are history and cannot be reinterpreted.
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

-- ============================================================
-- Wave 3 item 6: stage ordering and closed-stage integrity
-- ============================================================
CREATE OR REPLACE FUNCTION public._project_stage_biu()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.sequence, 0) = 0 THEN
      SELECT COALESCE(MAX(s.sequence), 0) + 10 INTO NEW.sequence
        FROM public.project_stages s WHERE s.project_id = NEW.project_id;
    END IF;
  ELSIF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'A stage cannot be moved to another project' USING ERRCODE = '23514';
  END IF;
  NEW.name := btrim(NEW.name);
  IF NEW.name = '' THEN
    RAISE EXCEPTION 'Stage name is required' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS project_stage_biu ON public.project_stages;
CREATE TRIGGER project_stage_biu
BEFORE INSERT OR UPDATE ON public.project_stages
FOR EACH ROW EXECUTE FUNCTION public._project_stage_biu();

CREATE OR REPLACE FUNCTION public._project_stage_bd()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.project_tasks t WHERE t.stage_id = OLD.id;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'This stage still holds % task(s) — move them to another stage first', v_count
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS project_stage_bd ON public.project_stages;
CREATE TRIGGER project_stage_bd
BEFORE DELETE ON public.project_stages
FOR EACH ROW EXECUTE FUNCTION public._project_stage_bd();

CREATE UNIQUE INDEX IF NOT EXISTS project_stages_project_name_uk
  ON public.project_stages (project_id, lower(name));