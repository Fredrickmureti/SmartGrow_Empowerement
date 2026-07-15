-- Bank-change payroll lock inside submit_profile_change_request.
-- Rejects bank_* field submissions while the employee has any payroll run
-- in an open state for the current period.
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
BEGIN
  IF NOT (p_field_key = ANY(v_hr_fields)) THEN
    RAISE EXCEPTION 'Field % does not require an HR change request', p_field_key USING ERRCODE = '22023';
  END IF;

  SELECT id, organization_id, to_jsonb(e.*) AS row_json
    INTO v_emp
    FROM public.employees e
    WHERE e.user_id = auth.uid() LIMIT 1;
  IF v_emp.id IS NULL THEN
    RAISE EXCEPTION 'No employee record linked to current user' USING ERRCODE = '42501';
  END IF;

  -- Bank-change payroll lock: block if the employee is inside an open payroll run.
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

  INSERT INTO public.employee_profile_change_requests
    (organization_id, employee_id, requested_by, field_key, old_value, new_value, reason)
  VALUES
    (v_emp.organization_id, v_emp.id, auth.uid(), p_field_key, v_old, p_new_value, p_reason)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_profile_change_request(text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_profile_change_request(text, jsonb, text) TO authenticated;