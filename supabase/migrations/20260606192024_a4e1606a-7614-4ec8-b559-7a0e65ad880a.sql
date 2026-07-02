
-- =========================================================================
-- C-HR-4: PII masking on employees
-- =========================================================================

-- 1. employee_credentials — move kiosk_pin_hash off the main table
CREATE TABLE IF NOT EXISTS public.employee_credentials (
  employee_id     uuid PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  kiosk_pin_hash  text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);

-- No access for anon/authenticated. Only SECURITY DEFINER RPCs touch this.
REVOKE ALL ON public.employee_credentials FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.employee_credentials TO service_role;

ALTER TABLE public.employee_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "employee_credentials_deny_all" ON public.employee_credentials;
CREATE POLICY "employee_credentials_deny_all" ON public.employee_credentials
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- Backfill existing pins
INSERT INTO public.employee_credentials(employee_id, kiosk_pin_hash)
SELECT id, kiosk_pin_hash FROM public.employees WHERE kiosk_pin_hash IS NOT NULL
ON CONFLICT (employee_id) DO UPDATE SET kiosk_pin_hash = EXCLUDED.kiosk_pin_hash;

-- 2. Rewrite kiosk RPCs against new table
CREATE OR REPLACE FUNCTION public.set_employee_kiosk_pin(_employee_id uuid, _pin text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  INSERT INTO public.employee_credentials(employee_id, kiosk_pin_hash, updated_by)
  VALUES (_employee_id, crypt(_pin, gen_salt('bf')), auth.uid())
  ON CONFLICT (employee_id) DO UPDATE
    SET kiosk_pin_hash = EXCLUDED.kiosk_pin_hash,
        updated_at = now(),
        updated_by = auth.uid();
END;
$function$;

CREATE OR REPLACE FUNCTION public.attendance_kiosk_clock(_organization_id uuid, _branch_id uuid, _employee_number text, _pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_employee record;
  v_pin_hash text;
  v_open_session record;
  v_result jsonb;
BEGIN
  SELECT * INTO v_employee
  FROM public.employees
  WHERE organization_id = _organization_id
    AND employee_number = _employee_number
    AND is_active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'employee_not_found');
  END IF;

  SELECT kiosk_pin_hash INTO v_pin_hash
  FROM public.employee_credentials
  WHERE employee_id = v_employee.id;

  IF v_pin_hash IS NULL OR v_pin_hash <> crypt(_pin, v_pin_hash) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_pin');
  END IF;

  SELECT * INTO v_open_session
  FROM public.attendance_sessions
  WHERE employee_id = v_employee.id AND clock_out_at IS NULL
  ORDER BY clock_in_at DESC LIMIT 1;

  IF FOUND THEN
    UPDATE public.attendance_sessions
       SET clock_out_at = now(), clock_out_source = 'kiosk'
     WHERE id = v_open_session.id;
    v_result := jsonb_build_object('ok', true, 'action', 'clock_out', 'session_id', v_open_session.id);
  ELSE
    INSERT INTO public.attendance_sessions(
      organization_id, branch_id, employee_id, clock_in_at, clock_in_source
    ) VALUES (
      _organization_id, _branch_id, v_employee.id, now(), 'kiosk'
    ) RETURNING jsonb_build_object('ok', true, 'action', 'clock_in', 'session_id', id) INTO v_result;
  END IF;

  RETURN v_result;
END;
$function$;

-- Now safe to drop the column
ALTER TABLE public.employees DROP COLUMN IF EXISTS kiosk_pin_hash;

-- 3. Permission helpers
CREATE OR REPLACE FUNCTION public.user_can_view_employee_private(_user_id uuid, _org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    public.has_role(_user_id, _org_id, 'super_admin'::public.app_role)
    OR public.has_role(_user_id, _org_id, 'owner'::public.app_role)
    OR public.has_role(_user_id, _org_id, 'admin'::public.app_role)
    OR public.user_has_module_permission(_user_id, _org_id, 'hr'::text, 'delete'::text)
    OR public.user_has_module_permission(_user_id, _org_id, 'hr'::text, 'write'::text)
$$;

CREATE OR REPLACE FUNCTION public.user_can_view_employee_payroll(_user_id uuid, _org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    public.has_role(_user_id, _org_id, 'super_admin'::public.app_role)
    OR public.has_role(_user_id, _org_id, 'owner'::public.app_role)
    OR public.has_role(_user_id, _org_id, 'admin'::public.app_role)
    OR public.user_has_module_permission(_user_id, _org_id, 'payroll'::text, 'read'::text)
$$;

GRANT EXECUTE ON FUNCTION public.user_can_view_employee_private(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_view_employee_payroll(uuid, uuid) TO authenticated;

-- 4. Safe view
DROP VIEW IF EXISTS public.v_employees_safe;
CREATE VIEW public.v_employees_safe
WITH (security_invoker = true)
AS
SELECT
  e.id, e.organization_id, e.business_id, e.branch_id, e.user_id, e.manager_id,
  e.department_id, e.department, e.position, e.job_position_id, e.work_location_id,
  e.employee_number, e.first_name, e.last_name, e.email, e.work_email, e.phone,
  e.hire_date, e.termination_date, e.employment_type, e.is_active,
  e.user_access_status, e.avatar_url, e.work_schedule_id, e.statutory_country_code,
  e.basic_salary, e.housing_allowance, e.transport_allowance, e.other_allowances,
  e.insurance_premium, e.cost_rate_override, e.labor_burden_pct,
  e.sms_consent, e.sms_consent_recorded_at,
  e.created_at, e.updated_at, e.created_by,
  -- Private PII (self OR viewEmployeePrivate)
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.national_id ELSE NULL END AS national_id,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.date_of_birth ELSE NULL END AS date_of_birth,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.personal_phone ELSE NULL END AS personal_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.gender ELSE NULL END AS gender,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.marital_status ELSE NULL END AS marital_status,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.address_line1 ELSE NULL END AS address_line1,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.address_line2 ELSE NULL END AS address_line2,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.city ELSE NULL END AS city,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.county ELSE NULL END AS county,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.postal_code ELSE NULL END AS postal_code,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.country ELSE NULL END AS country,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.emergency_contact_name ELSE NULL END AS emergency_contact_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.emergency_contact_phone ELSE NULL END AS emergency_contact_phone,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_private(auth.uid(), e.organization_id)
       THEN e.emergency_contact_relationship ELSE NULL END AS emergency_contact_relationship,
  -- Payroll/bank PII (self OR viewEmployeePayroll)
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id)
       THEN e.bank_name ELSE NULL END AS bank_name,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id)
       THEN e.bank_branch ELSE NULL END AS bank_branch,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id)
       THEN e.bank_account_number ELSE NULL END AS bank_account_number,
  CASE WHEN e.user_id = auth.uid() OR public.user_can_view_employee_payroll(auth.uid(), e.organization_id)
       THEN e.bank_code ELSE NULL END AS bank_code
FROM public.employees e;

GRANT SELECT ON public.v_employees_safe TO authenticated;

-- 5. REVOKE direct SELECT on PII columns from authenticated
REVOKE SELECT (
  national_id, date_of_birth, personal_phone, gender, marital_status,
  address_line1, address_line2, city, county, postal_code, country,
  emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
  bank_name, bank_branch, bank_account_number, bank_code
) ON public.employees FROM authenticated;

-- 6. Audited raw PII reader
CREATE OR REPLACE FUNCTION public.get_employee_pii(p_employee_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_emp record;
  v_is_self boolean;
  v_can_private boolean;
  v_can_payroll boolean;
BEGIN
  SELECT * INTO v_emp FROM public.employees WHERE id = p_employee_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'employee_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_is_self := (v_emp.user_id = auth.uid());
  v_can_private := public.user_can_view_employee_private(auth.uid(), v_emp.organization_id);
  v_can_payroll := public.user_can_view_employee_payroll(auth.uid(), v_emp.organization_id);

  IF NOT (v_is_self OR (v_can_private AND v_can_payroll)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- Audit
  BEGIN
    INSERT INTO public.audit_logs (
      organization_id, business_id, user_id, action, entity_type, entity_id, entity_name, new_values
    ) VALUES (
      v_emp.organization_id, v_emp.business_id, auth.uid(),
      'employee.pii.read', 'employee', p_employee_id,
      v_emp.first_name || ' ' || v_emp.last_name,
      jsonb_build_object(
        'scope', CASE WHEN v_is_self THEN 'self' ELSE 'admin' END,
        'fields', ARRAY['national_id','date_of_birth','personal_phone','address','emergency_contact','bank']
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'national_id', v_emp.national_id,
    'date_of_birth', v_emp.date_of_birth,
    'personal_phone', v_emp.personal_phone,
    'gender', v_emp.gender,
    'marital_status', v_emp.marital_status,
    'address_line1', v_emp.address_line1,
    'address_line2', v_emp.address_line2,
    'city', v_emp.city,
    'county', v_emp.county,
    'postal_code', v_emp.postal_code,
    'country', v_emp.country,
    'emergency_contact_name', v_emp.emergency_contact_name,
    'emergency_contact_phone', v_emp.emergency_contact_phone,
    'emergency_contact_relationship', v_emp.emergency_contact_relationship,
    'bank_name', v_emp.bank_name,
    'bank_branch', v_emp.bank_branch,
    'bank_account_number', v_emp.bank_account_number,
    'bank_code', v_emp.bank_code
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_employee_pii(uuid) TO authenticated;
