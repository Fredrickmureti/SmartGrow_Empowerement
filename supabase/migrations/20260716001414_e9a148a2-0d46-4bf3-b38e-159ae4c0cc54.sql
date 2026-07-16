
-- 1. Extend lifecycle event enum with identity-related event types.
ALTER TYPE public.employee_lifecycle_event_type ADD VALUE IF NOT EXISTS 'identity_email_change_requested';
ALTER TYPE public.employee_lifecycle_event_type ADD VALUE IF NOT EXISTS 'mfa_enrolled';
ALTER TYPE public.employee_lifecycle_event_type ADD VALUE IF NOT EXISTS 'mfa_unenrolled';

-- 2. Extend submit_profile_change_request whitelist with work_email so the
--    HR half of a sign-in email change is reviewable in the existing queue.
--    All other logic (payroll lock, event, notification) is preserved.
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
    'date_of_birth','gender',
    'work_email'
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

  INSERT INTO public.employee_lifecycle_events
    (organization_id, employee_id, event_type, actor_user_id, actor_label,
     source_table, source_id, summary, payload)
  VALUES
    (v_emp.organization_id, v_emp.id, 'profile_change_requested', auth.uid(),
     coalesce(v_emp_label, 'Employee'),
     'employee_profile_change_requests', v_id,
     format('Requested change to %s', p_field_key),
     jsonb_build_object('field_key', p_field_key, 'old_value', v_old, 'new_value', p_new_value, 'reason', p_reason));

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

-- 3. Log an identity email change intent. Called by /me/account right before
--    the client fires supabase.auth.updateUser({ email }). Emits a lifecycle
--    event for HR's audit trail and notifies HR admins so they can prepare
--    the accompanying work_email change request (if one applies).
CREATE OR REPLACE FUNCTION public.log_identity_email_change_intent(
  p_new_email text,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp record;
  v_emp_label text;
BEGIN
  IF p_new_email IS NULL OR length(trim(p_new_email)) = 0 THEN
    RAISE EXCEPTION 'New email is required' USING ERRCODE = '22023';
  END IF;

  SELECT id, organization_id, email,
         (coalesce(first_name,'') || ' ' || coalesce(last_name,'')) AS label
    INTO v_emp
    FROM public.employees
    WHERE user_id = auth.uid() LIMIT 1;

  -- Non-employee users (rare on this portal) may still change their own auth
  -- email, we simply skip the HR audit fanout in that case.
  IF v_emp.id IS NULL THEN
    RETURN;
  END IF;

  v_emp_label := nullif(trim(v_emp.label), '');

  INSERT INTO public.employee_lifecycle_events
    (organization_id, employee_id, event_type, actor_user_id, actor_label,
     source_table, source_id, summary, payload)
  VALUES
    (v_emp.organization_id, v_emp.id, 'identity_email_change_requested', auth.uid(),
     coalesce(v_emp_label, 'Employee'),
     'auth.users', auth.uid(),
     'Sign-in email change requested',
     jsonb_build_object('old_email', v_emp.email, 'new_email', p_new_email, 'reason', p_reason));

  INSERT INTO public.notifications
    (user_id, organization_id, title, message, type, category, priority,
     entity_type, entity_id, link)
  SELECT DISTINCT ur.user_id, v_emp.organization_id,
         'Sign-in email change requested',
         format('%s requested to change their sign-in email to %s. If this differs from their work email, review the HR change request queue.',
                coalesce(v_emp_label, 'An employee'), p_new_email),
         'info', 'hr', 2,
         'employee', v_emp.id,
         '/hr/employees/change-requests'
    FROM public.user_roles ur
   WHERE ur.role IN ('admin','super_admin','owner')
     AND ur.user_id <> auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.log_identity_email_change_intent(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_identity_email_change_intent(text, text) TO authenticated;

-- 4. Record MFA lifecycle. The MFA factors themselves live in auth.mfa_*
--    (managed by Supabase Auth). This function only writes the audit trail
--    into employee_lifecycle_events so HR has a durable record.
CREATE OR REPLACE FUNCTION public.record_mfa_lifecycle_event(
  p_action text,   -- 'enrolled' | 'unenrolled'
  p_factor_type text DEFAULT 'totp'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp record;
  v_emp_label text;
  v_event public.employee_lifecycle_event_type;
BEGIN
  IF p_action NOT IN ('enrolled','unenrolled') THEN
    RAISE EXCEPTION 'Invalid MFA action %', p_action USING ERRCODE = '22023';
  END IF;

  SELECT id, organization_id,
         (coalesce(first_name,'') || ' ' || coalesce(last_name,'')) AS label
    INTO v_emp
    FROM public.employees
    WHERE user_id = auth.uid() LIMIT 1;

  IF v_emp.id IS NULL THEN
    RETURN;
  END IF;

  v_emp_label := nullif(trim(v_emp.label), '');
  v_event := CASE WHEN p_action = 'enrolled' THEN 'mfa_enrolled'::public.employee_lifecycle_event_type
                  ELSE 'mfa_unenrolled'::public.employee_lifecycle_event_type END;

  INSERT INTO public.employee_lifecycle_events
    (organization_id, employee_id, event_type, actor_user_id, actor_label,
     source_table, source_id, summary, payload)
  VALUES
    (v_emp.organization_id, v_emp.id, v_event, auth.uid(),
     coalesce(v_emp_label, 'Employee'),
     'auth.mfa_factors', auth.uid(),
     CASE WHEN p_action = 'enrolled' THEN 'Enabled two-step verification'
          ELSE 'Removed two-step verification' END,
     jsonb_build_object('factor_type', p_factor_type));
END;
$$;

REVOKE ALL ON FUNCTION public.record_mfa_lifecycle_event(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_mfa_lifecycle_event(text, text) TO authenticated;
