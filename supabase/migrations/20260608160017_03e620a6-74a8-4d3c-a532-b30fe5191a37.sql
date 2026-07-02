-- =========================================================================
-- Wave E — Employee module hardening
-- =========================================================================

-- 1) Self-service column whitelist trigger ---------------------------------
CREATE OR REPLACE FUNCTION public.enforce_employee_self_update_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_is_self boolean;
  v_has_hr_write boolean;
BEGIN
  -- Only relevant when the updater is the linked user themselves.
  v_is_self := v_caller IS NOT NULL
               AND OLD.user_id IS NOT NULL
               AND OLD.user_id = v_caller;
  IF NOT v_is_self THEN
    RETURN NEW;
  END IF;

  -- HR managers / admins act with full power even when editing themselves.
  v_has_hr_write := public.user_has_module_permission(
    v_caller, OLD.organization_id, OLD.business_id, 'hr', 'write'
  );
  IF v_has_hr_write THEN
    RETURN NEW;
  END IF;

  -- Whitelisted personal fields. Anything else => reject.
  IF NEW.first_name IS DISTINCT FROM OLD.first_name
     OR NEW.last_name IS DISTINCT FROM OLD.last_name
     OR NEW.avatar_url IS DISTINCT FROM OLD.avatar_url
     OR NEW.phone IS DISTINCT FROM OLD.phone
     OR NEW.personal_phone IS DISTINCT FROM OLD.personal_phone
     OR NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth
     OR NEW.marital_status IS DISTINCT FROM OLD.marital_status
     OR NEW.emergency_contact_name IS DISTINCT FROM OLD.emergency_contact_name
     OR NEW.emergency_contact_phone IS DISTINCT FROM OLD.emergency_contact_phone
     OR NEW.emergency_contact_relationship IS DISTINCT FROM OLD.emergency_contact_relationship
     OR NEW.address_line1 IS DISTINCT FROM OLD.address_line1
     OR NEW.address_line2 IS DISTINCT FROM OLD.address_line2
     OR NEW.city IS DISTINCT FROM OLD.city
     OR NEW.county IS DISTINCT FROM OLD.county
     OR NEW.postal_code IS DISTINCT FROM OLD.postal_code
     OR NEW.country IS DISTINCT FROM OLD.country
  THEN
    -- whitelisted edits are fine — fall through to the protected-column check
    NULL;
  END IF;

  -- Protected columns: explicitly enumerate every field that MUST NOT
  -- change through self-service. Anything sensitive about employment,
  -- pay, or organizational hierarchy is here.
  IF NEW.basic_salary IS DISTINCT FROM OLD.basic_salary
     OR NEW.employment_type IS DISTINCT FROM OLD.employment_type
     OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.manager_id IS DISTINCT FROM OLD.manager_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.hire_date IS DISTINCT FROM OLD.hire_date
     OR NEW.termination_date IS DISTINCT FROM OLD.termination_date
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.employee_number IS DISTINCT FROM OLD.employee_number
     OR NEW.job_position_id IS DISTINCT FROM OLD.job_position_id
     OR NEW.work_location_id IS DISTINCT FROM OLD.work_location_id
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.work_email IS DISTINCT FROM OLD.work_email
     OR NEW.bank_account_number IS DISTINCT FROM OLD.bank_account_number
     OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
     OR NEW.bank_branch IS DISTINCT FROM OLD.bank_branch
     OR NEW.bank_code IS DISTINCT FROM OLD.bank_code
     OR NEW.national_id IS DISTINCT FROM OLD.national_id
  THEN
    RAISE EXCEPTION 'Self-service updates cannot change protected fields. Contact HR.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employees_enforce_self_update ON public.employees;
CREATE TRIGGER employees_enforce_self_update
  BEFORE UPDATE ON public.employees
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_employee_self_update_columns();


-- 2) terminate_employee ---------------------------------------------------
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
SET search_path = public
AS $$
DECLARE
  v_caller     uuid := auth.uid();
  v_emp        record;
  v_spell_id   uuid;
  v_type_map   text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT id, organization_id, business_id, first_name, last_name
    INTO v_emp
  FROM public.employees
  WHERE id = p_employee_id;
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
$$;

GRANT EXECUTE ON FUNCTION public.terminate_employee(uuid, date, text, text, jsonb) TO authenticated;


-- 3) rehire_employee ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rehire_employee(
  p_employee_id     uuid,
  p_start_date      date,
  p_employment_type text DEFAULT 'full_time',
  p_business_id     uuid DEFAULT NULL,
  p_branch_id       uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller   uuid := auth.uid();
  v_emp      record;
  v_active   uuid;
  v_business uuid;
  v_branch   uuid;
  v_new_id   uuid;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT id, organization_id, business_id, branch_id, first_name, last_name
    INTO v_emp
  FROM public.employees
  WHERE id = p_employee_id;
  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002';
  END IF;

  v_business := COALESCE(p_business_id, v_emp.business_id);
  v_branch   := COALESCE(p_branch_id,   v_emp.branch_id);

  IF NOT public.user_has_module_permission(
    v_caller, v_emp.organization_id, v_business, 'hr', 'write'
  ) THEN
    RAISE EXCEPTION 'HR write permission required' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_active
  FROM public.employments
  WHERE employee_id = p_employee_id AND status <> 'terminated'
  LIMIT 1;
  IF v_active IS NOT NULL THEN
    RAISE EXCEPTION 'Employee already has an active employment spell'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.employments (
    organization_id, business_id, branch_id, employee_id,
    start_date, employment_type, status, is_primary, created_by
  ) VALUES (
    v_emp.organization_id, v_business, v_branch, p_employee_id,
    COALESCE(p_start_date, CURRENT_DATE),
    COALESCE(p_employment_type, 'full_time'),
    'active', TRUE, v_caller
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id,
    action, entity_type, entity_id, entity_name,
    new_values, changes_summary
  ) VALUES (
    v_emp.organization_id, v_business, v_caller,
    'employee_rehired', 'employee', v_emp.id,
    v_emp.first_name || ' ' || v_emp.last_name,
    jsonb_build_object(
      'start_date', COALESCE(p_start_date, CURRENT_DATE),
      'employment_type', COALESCE(p_employment_type, 'full_time'),
      'business_id', v_business, 'branch_id', v_branch
    ),
    'Employee rehired'
  );

  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rehire_employee(uuid, date, text, uuid, uuid) TO authenticated;


-- 4) transfer_employee ----------------------------------------------------
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

  -- Caller must have HR write on BOTH source and destination.
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
    COALESCE(p_effective_date, CURRENT_DATE)::timestamptz,
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

  -- Update employee row (bypasses self-update trigger because caller is HR).
  UPDATE public.employees
     SET business_id     = v_target_business,
         branch_id       = COALESCE(p_new_branch_id, branch_id),
         department_id   = COALESCE(p_new_department_id, department_id),
         job_position_id = COALESCE(p_new_job_position_id, job_position_id),
         manager_id      = COALESCE(p_new_manager_id, manager_id)
   WHERE id = p_employee_id;

  -- Keep the active employment spell in sync with the new business/branch.
  UPDATE public.employments
     SET business_id = v_target_business,
         branch_id   = COALESCE(p_new_branch_id, branch_id)
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
      'effective_date', COALESCE(p_effective_date, CURRENT_DATE),
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


-- 5) change_compensation --------------------------------------------------
CREATE OR REPLACE FUNCTION public.change_compensation(
  p_employee_id      uuid,
  p_effective_date   date,
  p_new_basic_salary numeric,
  p_allowances       jsonb DEFAULT '{}'::jsonb,
  p_currency         text  DEFAULT NULL,
  p_change_type      text  DEFAULT 'adjustment',
  p_reason           text  DEFAULT NULL
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
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_new_basic_salary IS NULL OR p_new_basic_salary < 0 THEN
    RAISE EXCEPTION 'Basic salary must be a non-negative number'
      USING ERRCODE = '22023';
  END IF;

  SELECT id, organization_id, business_id, first_name, last_name, basic_salary
    INTO v_emp
  FROM public.employees WHERE id = p_employee_id;
  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION 'Employee not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_has_module_permission(
    v_caller, v_emp.organization_id, v_emp.business_id, 'hr', 'write'
  ) THEN
    RAISE EXCEPTION 'HR write permission required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.employee_compensation_history (
    organization_id, business_id, employee_id, effective_date,
    basic_salary, allowances_json, currency_code,
    change_type, reason, created_by
  ) VALUES (
    v_emp.organization_id, v_emp.business_id, p_employee_id,
    COALESCE(p_effective_date, CURRENT_DATE),
    p_new_basic_salary, COALESCE(p_allowances, '{}'::jsonb), p_currency,
    COALESCE(p_change_type, 'adjustment'), p_reason, v_caller
  )
  RETURNING id INTO v_hist_id;

  UPDATE public.employees
     SET basic_salary = p_new_basic_salary
   WHERE id = p_employee_id;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id,
    action, entity_type, entity_id, entity_name,
    old_values, new_values, changes_summary
  ) VALUES (
    v_emp.organization_id, v_emp.business_id, v_caller,
    'employee_compensation_changed', 'employee', v_emp.id,
    v_emp.first_name || ' ' || v_emp.last_name,
    jsonb_build_object('basic_salary', v_emp.basic_salary),
    jsonb_build_object(
      'basic_salary', p_new_basic_salary,
      'effective_date', COALESCE(p_effective_date, CURRENT_DATE),
      'change_type', COALESCE(p_change_type, 'adjustment'),
      'reason', p_reason
    ),
    'Compensation changed'
  );

  RETURN v_hist_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.change_compensation(uuid, date, numeric, jsonb, text, text, text) TO authenticated;
