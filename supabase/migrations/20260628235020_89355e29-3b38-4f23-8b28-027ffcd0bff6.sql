
-- Rewrite transfer_employee to route branch changes through
-- transfer_employee_primary_branch instead of writing employees.branch_id
-- directly. Direct writes are now blocked by the Phase A guard trigger.

CREATE OR REPLACE FUNCTION public.transfer_employee(
  p_employee_id        uuid,
  p_effective_date     date,
  p_new_business_id    uuid DEFAULT NULL,
  p_new_branch_id      uuid DEFAULT NULL,
  p_new_department_id  uuid DEFAULT NULL,
  p_new_job_position_id uuid DEFAULT NULL,
  p_new_manager_id     uuid DEFAULT NULL,
  p_reason             text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_emp    record;
  v_hist_id uuid;
  v_target_business uuid;
  v_effective date := COALESCE(p_effective_date, CURRENT_DATE);
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT id, organization_id, business_id, branch_id, department_id,
         job_position_id, manager_id, employment_type, first_name, last_name
    INTO v_emp
  FROM public.employees WHERE id = p_employee_id;
  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002';
  END IF;

  v_target_business := COALESCE(p_new_business_id, v_emp.business_id);

  IF NOT public.user_has_module_permission(
       v_caller, v_emp.organization_id, v_emp.business_id, 'hr', 'write')
     OR NOT public.user_has_module_permission(
       v_caller, v_emp.organization_id, v_target_business, 'hr', 'write')
  THEN
    RAISE EXCEPTION 'HR write permission required on source and destination'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.employee_position_history (
    organization_id, employee_id, effective_from,
    department_id, branch_id, job_position_id, manager_id, employment_type,
    prev_department_id, prev_branch_id, prev_job_position_id,
    prev_manager_id, prev_employment_type,
    change_reason, changed_by
  ) VALUES (
    v_emp.organization_id, p_employee_id,
    v_effective::timestamptz,
    COALESCE(p_new_department_id, v_emp.department_id),
    COALESCE(p_new_branch_id, v_emp.branch_id),
    COALESCE(p_new_job_position_id, v_emp.job_position_id),
    COALESCE(p_new_manager_id, v_emp.manager_id),
    v_emp.employment_type,
    v_emp.department_id, v_emp.branch_id, v_emp.job_position_id,
    v_emp.manager_id, v_emp.employment_type,
    p_reason, v_caller
  )
  RETURNING id INTO v_hist_id;

  -- Update non-branch employee fields directly (not guarded).
  UPDATE public.employees
     SET business_id     = v_target_business,
         department_id   = COALESCE(p_new_department_id, department_id),
         job_position_id = COALESCE(p_new_job_position_id, job_position_id),
         manager_id      = COALESCE(p_new_manager_id, manager_id)
   WHERE id = p_employee_id;

  -- Branch change goes through the assignment table.
  IF p_new_branch_id IS NOT NULL AND p_new_branch_id IS DISTINCT FROM v_emp.branch_id THEN
    PERFORM public.transfer_employee_primary_branch(
      p_employee_id, p_new_branch_id, v_effective, p_reason);
  END IF;

  -- Keep the active employment spell's business in sync. Skip branch_id —
  -- employments is deprecated and not on the read path.
  UPDATE public.employments
     SET business_id = v_target_business
   WHERE employee_id = p_employee_id
     AND status <> 'terminated';

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id,
    action, entity_type, entity_id, entity_name,
    new_values, changes_summary
  ) VALUES (
    v_emp.organization_id, v_target_business, v_caller,
    'employee_transferred', 'employee', v_emp.id,
    v_emp.first_name || ' ' || v_emp.last_name,
    jsonb_build_object(
      'effective_date', v_effective,
      'business_id', v_target_business,
      'branch_id', p_new_branch_id,
      'department_id', p_new_department_id,
      'job_position_id', p_new_job_position_id,
      'manager_id', p_new_manager_id,
      'reason', p_reason
    ),
    'Employee transferred'
  );

  RETURN v_hist_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.transfer_employee(uuid, date, uuid, uuid, uuid, uuid, uuid, text) TO authenticated;

-- Top-up backfill: any employee with a legacy branch_id but no open
-- assignment row gets one. Phase A's backfill covered this for rows that
-- existed then; this catches drift between Phase A and now.
INSERT INTO public.employee_branch_assignments
  (organization_id, business_id, employee_id, branch_id, is_primary,
   assignment_type, effective_from, notes)
SELECT e.organization_id, e.business_id, e.id, e.branch_id, true, 'permanent',
       COALESCE(e.hire_date, CURRENT_DATE),
       'Top-up backfill from employees.branch_id'
FROM public.employees e
WHERE e.branch_id IS NOT NULL
  AND e.business_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.employee_branch_assignments a
    WHERE a.employee_id = e.id AND a.effective_to IS NULL
  );
