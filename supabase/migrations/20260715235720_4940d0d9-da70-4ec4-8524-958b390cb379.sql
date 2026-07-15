
-- 1. Extend the lifecycle event enum with profile-change values.
ALTER TYPE public.employee_lifecycle_event_type ADD VALUE IF NOT EXISTS 'profile_change_requested';
ALTER TYPE public.employee_lifecycle_event_type ADD VALUE IF NOT EXISTS 'profile_change_approved';
ALTER TYPE public.employee_lifecycle_event_type ADD VALUE IF NOT EXISTS 'profile_change_rejected';

-- 2. submit_profile_change_request — emit lifecycle event + notify HR reviewers.
CREATE OR REPLACE FUNCTION public.submit_profile_change_request(
  p_field_key text,
  p_new_value jsonb,
  p_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp record;
  v_id uuid;
  v_old jsonb;
  v_hr_fields text[] := ARRAY[
    'first_name','last_name','national_id',
    'bank_name','bank_branch','bank_account_number','bank_code',
    'date_of_birth','gender'
  ];
  v_open_run_exists boolean;
  v_emp_label text;
BEGIN
  IF NOT (p_field_key = ANY(v_hr_fields)) THEN
    RAISE EXCEPTION 'Field % does not require an HR change request', p_field_key USING ERRCODE = '22023';
  END IF;

  SELECT id, organization_id, to_jsonb(e.*) AS row_json,
         (coalesce(e.first_name,'') || ' ' || coalesce(e.last_name,'')) AS label
    INTO v_emp
    FROM public.employees e
    WHERE e.user_id = auth.uid() LIMIT 1;
  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION 'No employee record linked to current user' USING ERRCODE = '42501';
  END IF;

  -- Bank-change payroll lock.
  IF p_field_key IN ('bank_name','bank_branch','bank_account_number','bank_code') THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.payroll_runs pr
        JOIN public.payslips ps ON ps.payroll_run_id = pr.id
       WHERE ps.employee_id = v_emp.id
         AND pr.status IN ('draft','calculating','review','approved')
    ) INTO v_open_run_exists;
    IF v_open_run_exists THEN
      RAISE EXCEPTION 'Bank details cannot be changed while a payroll run is open. Please try again after the current run is finalised.'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  v_old := v_emp.row_json -> p_field_key;
  v_emp_label := nullif(trim(v_emp.label), '');

  INSERT INTO public.employee_profile_change_requests
    (organization_id, employee_id, requested_by, field_key, old_value, new_value, reason)
  VALUES
    (v_emp.organization_id, v_emp.id, auth.uid(), p_field_key, v_old, p_new_value, p_reason)
  RETURNING id INTO v_id;

  -- Durable audit trail.
  INSERT INTO public.employee_lifecycle_events
    (organization_id, employee_id, event_type, actor_user_id, actor_label,
     source_table, source_id, summary, payload)
  VALUES
    (v_emp.organization_id, v_emp.id, 'profile_change_requested', auth.uid(),
     coalesce(v_emp_label, 'Employee'),
     'employee_profile_change_requests', v_id,
     format('Requested change to %s', p_field_key),
     jsonb_build_object('field_key', p_field_key, 'old_value', v_old, 'new_value', p_new_value, 'reason', p_reason));

  -- Notify HR reviewers in the same org so they see the pending queue.
  INSERT INTO public.notifications
    (user_id, organization_id, title, message, type, category, priority,
     entity_type, entity_id, link)
  SELECT DISTINCT ur.user_id, v_emp.organization_id,
         'Profile change request',
         format('%s requested a change to %s. Review it in the change requests queue.',
                coalesce(v_emp_label, 'An employee'), p_field_key),
         'info', 'hr', 2,
         'employee_profile_change_request', v_id,
         '/hr/employees/change-requests'
    FROM public.user_roles ur
   WHERE ur.role IN ('admin','super_admin','owner')
     AND ur.user_id <> auth.uid();

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_profile_change_request(text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_profile_change_request(text, jsonb, text) TO authenticated;

-- 3. review_profile_change_request — emit lifecycle event + notify employee.
CREATE OR REPLACE FUNCTION public.review_profile_change_request(
  p_request_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
  v_emp_user_id uuid;
  v_event_type public.employee_lifecycle_event_type;
BEGIN
  IF p_decision NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'Invalid decision %', p_decision USING ERRCODE = '22023';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'owner')
  ) THEN
    RAISE EXCEPTION 'Only HR admins may review change requests' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_req FROM public.employee_profile_change_requests
   WHERE id = p_request_id AND status = 'pending' FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Request not found or not pending';
  END IF;

  UPDATE public.employee_profile_change_requests SET
    status = p_decision,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    review_note = p_note,
    updated_at = now()
  WHERE id = p_request_id;

  IF p_decision = 'approved' THEN
    EXECUTE format(
      'UPDATE public.employees SET %I = $1, updated_at = now() WHERE id = $2',
      v_req.field_key
    ) USING (v_req.new_value #>> '{}'), v_req.employee_id;
    v_event_type := 'profile_change_approved';
  ELSE
    v_event_type := 'profile_change_rejected';
  END IF;

  -- Audit trail.
  INSERT INTO public.employee_lifecycle_events
    (organization_id, employee_id, event_type, actor_user_id,
     source_table, source_id, summary, payload)
  VALUES
    (v_req.organization_id, v_req.employee_id, v_event_type, auth.uid(),
     'employee_profile_change_requests', v_req.id,
     format('%s change to %s', initcap(p_decision), v_req.field_key),
     jsonb_build_object('field_key', v_req.field_key,
                        'old_value', v_req.old_value,
                        'new_value', v_req.new_value,
                        'decision', p_decision,
                        'note', p_note));

  -- Notify the employee (if linked to a user).
  SELECT user_id INTO v_emp_user_id FROM public.employees WHERE id = v_req.employee_id;
  IF v_emp_user_id IS NOT NULL THEN
    INSERT INTO public.notifications
      (user_id, organization_id, title, message, type, category, priority,
       entity_type, entity_id, link)
    VALUES
      (v_emp_user_id, v_req.organization_id,
       CASE WHEN p_decision = 'approved' THEN 'Profile change approved'
            ELSE 'Profile change rejected' END,
       format('Your request to change %s was %s%s.',
              v_req.field_key, p_decision,
              CASE WHEN p_note IS NOT NULL AND length(trim(p_note)) > 0
                   THEN ' — ' || p_note ELSE '' END),
       CASE WHEN p_decision = 'approved' THEN 'success' ELSE 'warning' END,
       'hr', 2,
       'employee_profile_change_request', v_req.id,
       '/me/profile');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.review_profile_change_request(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.review_profile_change_request(uuid, text, text) TO authenticated;
