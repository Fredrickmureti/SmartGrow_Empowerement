-- =========================================================================
-- Employee Module — Phase B (canonical read model) + Phase C (write-path gaps)
-- =========================================================================

-- 1. Canonical read view (single derived-column surface)
CREATE OR REPLACE VIEW public.v_employees_canonical
WITH (security_invoker = on) AS
SELECT
  e.*,
  emp.lifecycle_status                                            AS _lifecycle_status,
  emp.draft_owner_id                                              AS _draft_owner_id,
  CASE emp.lifecycle_status::text
    WHEN 'draft'     THEN 'draft'
    WHEN 'active'    THEN 'active'
    WHEN 'on_leave'  THEN 'active'
    WHEN 'notice'    THEN 'active'
    WHEN 'suspended' THEN 'active'
    WHEN 'exited'    THEN 'exited'
    WHEN 'archived'  THEN 'archived'
    ELSE 'unknown'
  END                                                             AS lifecycle_bucket,
  (emp.lifecycle_status::text NOT IN ('draft','archived'))        AS is_directory_visible,
  (emp.lifecycle_status::text IN
     ('active','on_leave','notice','suspended'))                  AS is_operationally_active,
  (emp.lifecycle_status::text = 'active'
    AND EXISTS (
      SELECT 1 FROM public.employee_contracts c
       WHERE c.employee_id = emp.id
         AND c.status::text = 'running'
    ))                                                            AS is_payroll_eligible
FROM public.v_employees_safe e
JOIN public.employees emp ON emp.id = e.id;

GRANT SELECT ON public.v_employees_canonical TO authenticated;
GRANT SELECT ON public.v_employees_canonical TO service_role;

COMMENT ON VIEW public.v_employees_canonical IS
  'Canonical employee read model. Use is_directory_visible, is_operationally_active, '
  'is_payroll_eligible, lifecycle_bucket — do NOT re-derive lifecycle predicates in queries.';

-- 2. Per-row draft discard RPC
CREATE OR REPLACE FUNCTION public.discard_employee_draft(p_employee_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller   uuid := auth.uid();
  v_owner    uuid;
  v_org      uuid;
  v_business uuid;
  v_status   text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_employee_id IS NULL THEN
    RAISE EXCEPTION 'employee_id is required';
  END IF;

  SELECT draft_owner_id, organization_id, business_id, lifecycle_status::text
    INTO v_owner, v_org, v_business, v_status
  FROM public.employees
  WHERE id = p_employee_id
  FOR UPDATE;

  IF v_org IS NULL THEN
    RETURN false; -- idempotent
  END IF;

  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Only draft employees can be discarded (status=%)', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_owner IS DISTINCT FROM v_caller
     AND NOT public.user_has_module_permission(v_caller, v_org, v_business, 'hr', 'write')
  THEN
    RAISE EXCEPTION 'Only the draft owner or an HR administrator can discard this draft'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.employees WHERE id = p_employee_id;
  RETURN true;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.discard_employee_draft(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.discard_employee_draft(uuid) TO service_role;

-- 3. Scheduled cleanup of abandoned drafts (assumes pg_cron is already installed)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discard-stale-employee-drafts') THEN
      PERFORM cron.unschedule('discard-stale-employee-drafts');
    END IF;
    PERFORM cron.schedule(
      'discard-stale-employee-drafts',
      '0 3 * * *',
      $cron$SELECT public.discard_stale_employee_drafts(NULL, NULL, 24 * 7)$cron$
    );
  END IF;
END
$$;

-- 4. archive_employee — writer for the exited → archived terminal step
CREATE OR REPLACE FUNCTION public.archive_employee(p_employee_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller   uuid := auth.uid();
  v_org      uuid;
  v_business uuid;
  v_status   text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, business_id, lifecycle_status::text
    INTO v_org, v_business, v_status
  FROM public.employees
  WHERE id = p_employee_id
  FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_has_module_permission(v_caller, v_org, v_business, 'hr', 'write') THEN
    RAISE EXCEPTION 'HR write permission required' USING ERRCODE = '42501';
  END IF;

  IF v_status = 'archived' THEN
    RETURN false;
  END IF;
  IF v_status <> 'exited' THEN
    RAISE EXCEPTION 'Only exited employees can be archived (status=%)', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.employees
     SET lifecycle_status = 'archived'::public.employee_lifecycle_status,
         updated_at       = now()
   WHERE id = p_employee_id;

  RETURN true;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.archive_employee(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.archive_employee(uuid) TO service_role;

-- 5. terminate_employee — also flip employees.lifecycle_status to 'exited'
CREATE OR REPLACE FUNCTION public.terminate_employee(
  p_employee_id uuid,
  p_end_date    date,
  p_type        text,
  p_reason      text,
  p_exit_data   jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller     uuid := auth.uid();
  v_emp        record;
  v_spell_id   uuid;
  v_type_map   text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT id, organization_id, business_id, first_name, last_name,
         lifecycle_status::text AS lifecycle_status
    INTO v_emp
  FROM public.employees
  WHERE id = p_employee_id
  FOR UPDATE;
  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_has_module_permission(
    v_caller, v_emp.organization_id, v_emp.business_id, 'hr', 'write'
  ) THEN
    RAISE EXCEPTION 'HR write permission required' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_spell_id
  FROM public.employments
  WHERE employee_id = p_employee_id
    AND status <> 'terminated'
  ORDER BY start_date DESC
  LIMIT 1;
  IF v_spell_id IS NULL THEN
    RAISE EXCEPTION 'No active employment spell to terminate' USING ERRCODE = 'P0002';
  END IF;

  v_type_map := CASE p_type
    WHEN 'voluntary'       THEN 'voluntary'
    WHEN 'involuntary'     THEN 'involuntary'
    WHEN 'end_of_contract' THEN 'end_of_contract'
    WHEN 'retirement'      THEN 'retirement'
    WHEN 'redundancy'      THEN 'involuntary'
    WHEN 'death'           THEN 'death'
    ELSE 'other'
  END;

  UPDATE public.employments
     SET status             = 'terminated',
         end_date           = COALESCE(p_end_date, CURRENT_DATE),
         termination_type   = v_type_map,
         termination_reason = NULLIF(p_reason, '')
   WHERE id = v_spell_id;

  -- Drive employees.lifecycle_status to 'exited' in the same tx so the
  -- directory, stats and downstream reads observe a single consistent state.
  IF v_emp.lifecycle_status IN ('active','on_leave','notice','suspended') THEN
    UPDATE public.employees
       SET lifecycle_status = 'exited'::public.employee_lifecycle_status,
           termination_date = COALESCE(p_end_date, CURRENT_DATE),
           updated_at       = now()
     WHERE id = p_employee_id;
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id,
    action, entity_type, entity_id, entity_name,
    new_values, changes_summary
  ) VALUES (
    v_emp.organization_id, v_emp.business_id, v_caller,
    'employee_terminated', 'employee', v_emp.id,
    v_emp.first_name || ' ' || v_emp.last_name,
    jsonb_build_object(
      'end_date', COALESCE(p_end_date, CURRENT_DATE),
      'type', v_type_map,
      'reason', p_reason,
      'exit_data', p_exit_data
    ),
    'Employee terminated (' || v_type_map || ')'
  );

  RETURN v_spell_id;
END;
$function$;

-- 6. link_employee_to_user — refuse to link a draft unless p_force=true
CREATE OR REPLACE FUNCTION public.link_employee_to_user(
  p_employee_id uuid, p_user_id uuid, p_force boolean DEFAULT false
)
RETURNS TABLE(was_changed boolean, employee_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_org_id uuid;
  v_business_id uuid;
  v_prev_user uuid;
  v_lifecycle text;
  v_caller_admin boolean;
  v_owner_user uuid;
  v_target_is_platform_admin boolean;
  v_other_employee uuid;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_employee_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'employee_id and user_id are required';
  END IF;

  SELECT organization_id, business_id, user_id, lifecycle_status::text
    INTO v_org_id, v_business_id, v_prev_user, v_lifecycle
    FROM public.employees WHERE id = p_employee_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Employee not found'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = v_caller AND organization_id = v_org_id
       AND is_active = true AND role IN ('owner','admin','super_admin')
  ) INTO v_caller_admin;
  IF NOT v_caller_admin THEN
    RAISE EXCEPTION 'Only workspace administrators can link employee records.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_prev_user = p_user_id THEN
    was_changed := false; employee_id := p_employee_id; RETURN NEXT; RETURN;
  END IF;

  -- Draft guard. Linking a pre-activation row leaks an auth link into
  -- the operational graph before the data is committed.
  IF v_lifecycle = 'draft' AND NOT p_force THEN
    RAISE EXCEPTION 'You are about to link a draft employee to a user account. Promote the draft first, or re-submit with confirm=true.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id INTO v_other_employee
    FROM public.employees
   WHERE organization_id = v_org_id AND user_id = p_user_id AND id <> p_employee_id
   LIMIT 1;
  IF v_other_employee IS NOT NULL THEN
    RAISE EXCEPTION 'That user is already linked to another employee record (%) in this workspace.', v_other_employee
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT owner_user_id INTO v_owner_user FROM public.organizations WHERE id = v_org_id;
  SELECT EXISTS(
    SELECT 1 FROM public.platform_admins WHERE user_id = p_user_id AND is_active = true
  ) INTO v_target_is_platform_admin;

  IF p_user_id = v_owner_user AND NOT p_force THEN
    RAISE EXCEPTION 'You are about to link the workspace owner to an employee record. Re-submit with confirm=true.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_target_is_platform_admin AND NOT p_force THEN
    RAISE EXCEPTION 'You are about to link a platform administrator to an employee record. Re-submit with confirm=true.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user_id = v_caller AND NOT p_force THEN
    RAISE EXCEPTION 'You are about to link your own account to an employee record. Re-submit with confirm=true.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('app.identity_change_source','link_employee_to_user', true);
  PERFORM set_config('app.identity_change_reason',
    CASE WHEN p_force THEN 'forced by admin' ELSE 'standard' END, true);

  UPDATE public.employees SET user_id = p_user_id WHERE id = p_employee_id;

  PERFORM set_config('app.identity_change_source','', true);
  PERFORM set_config('app.identity_change_reason','', true);

  was_changed := true; employee_id := p_employee_id; RETURN NEXT;
END;
$function$;

-- 7. tg_employees_lifecycle — do NOT emit 'hired' for draft inserts
CREATE OR REPLACE FUNCTION public.tg_employees_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_was_archived boolean;
  v_is_archived  boolean;
  v_was_draft    boolean;
  v_is_draft     boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only operational inserts emit 'hired'. Drafts emit nothing until
    -- they're promoted (handled in the UPDATE branch below).
    IF NEW.lifecycle_status::text <> 'draft' THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        'hired', 'Employee record created',
        jsonb_build_object('hire_date', NEW.hire_date),
        'employees', NEW.id, NEW.hire_date, NULL
      );
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    v_was_archived := (OLD.lifecycle_status::text = 'archived');
    v_is_archived  := (NEW.lifecycle_status::text = 'archived');
    v_was_draft    := (OLD.lifecycle_status::text = 'draft');
    v_is_draft     := (NEW.lifecycle_status::text = 'draft');

    -- Draft → non-draft promotion emits the 'hired' event the INSERT skipped.
    IF v_was_draft AND NOT v_is_draft AND NEW.lifecycle_status::text <> 'archived' THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        'hired', 'Employee record activated',
        jsonb_build_object('hire_date', NEW.hire_date),
        'employees', NEW.id, NEW.hire_date, NULL
      );
    END IF;

    IF v_is_archived IS DISTINCT FROM v_was_archived THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        CASE WHEN v_is_archived THEN 'archived' ELSE 'unarchived' END,
        CASE WHEN v_is_archived THEN 'Employee archived' ELSE 'Employee unarchived' END,
        '{}'::jsonb, 'employees', NEW.id, NULL, NULL
      );
    END IF;

    -- Suppress org-shape change events while the row is still a draft.
    IF NOT v_is_draft THEN
      IF NEW.department_id IS DISTINCT FROM OLD.department_id THEN
        PERFORM public.emit_employee_lifecycle_event(
          NEW.organization_id, NEW.business_id, NEW.id,
          'department_transferred', 'Department changed',
          jsonb_build_object('from', OLD.department_id, 'to', NEW.department_id),
          'employees', NEW.id, NULL, NULL
        );
      END IF;
      IF NEW.manager_id IS DISTINCT FROM OLD.manager_id THEN
        PERFORM public.emit_employee_lifecycle_event(
          NEW.organization_id, NEW.business_id, NEW.id,
          'manager_changed', 'Manager changed',
          jsonb_build_object('from', OLD.manager_id, 'to', NEW.manager_id),
          'employees', NEW.id, NULL, NULL
        );
      END IF;
      IF NEW.job_position_id IS DISTINCT FROM OLD.job_position_id THEN
        PERFORM public.emit_employee_lifecycle_event(
          NEW.organization_id, NEW.business_id, NEW.id,
          'position_changed', 'Position changed',
          jsonb_build_object('from', OLD.job_position_id, 'to', NEW.job_position_id),
          'employees', NEW.id, NULL, NULL
        );
      END IF;
      IF NEW.work_location_id IS DISTINCT FROM OLD.work_location_id THEN
        PERFORM public.emit_employee_lifecycle_event(
          NEW.organization_id, NEW.business_id, NEW.id,
          'location_transferred', 'Work location changed',
          jsonb_build_object('from', OLD.work_location_id, 'to', NEW.work_location_id),
          'employees', NEW.id, NULL, NULL
        );
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;