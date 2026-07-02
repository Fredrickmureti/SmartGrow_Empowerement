
CREATE TABLE IF NOT EXISTS public.employee_branch_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  is_primary boolean NOT NULL DEFAULT false,
  assignment_type text NOT NULL DEFAULT 'permanent'
    CHECK (assignment_type IN ('permanent','secondment','temporary','coverage')),
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eba_effective_range_ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_eba_employee ON public.employee_branch_assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_eba_branch ON public.employee_branch_assignments(branch_id);
CREATE INDEX IF NOT EXISTS idx_eba_org_biz ON public.employee_branch_assignments(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_eba_current ON public.employee_branch_assignments(employee_id) WHERE effective_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_eba_primary_open
  ON public.employee_branch_assignments(employee_id)
  WHERE is_primary = true AND effective_to IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_eba_employee_branch_open
  ON public.employee_branch_assignments(employee_id, branch_id)
  WHERE effective_to IS NULL;

CREATE OR REPLACE FUNCTION public._eba_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_eba_touch_updated_at ON public.employee_branch_assignments;
CREATE TRIGGER trg_eba_touch_updated_at
  BEFORE UPDATE ON public.employee_branch_assignments
  FOR EACH ROW EXECUTE FUNCTION public._eba_touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_branch_assignments TO authenticated;
GRANT ALL ON public.employee_branch_assignments TO service_role;

ALTER TABLE public.employee_branch_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "eba_select_via_employee" ON public.employee_branch_assignments;
CREATE POLICY "eba_select_via_employee"
  ON public.employee_branch_assignments FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.employees e WHERE e.id = employee_branch_assignments.employee_id));

DROP POLICY IF EXISTS "eba_write_admin" ON public.employee_branch_assignments;
CREATE POLICY "eba_write_admin"
  ON public.employee_branch_assignments FOR ALL
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'super_admin')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'super_admin')
  );

INSERT INTO public.employee_branch_assignments
  (organization_id, business_id, employee_id, branch_id, is_primary,
   assignment_type, effective_from, notes)
SELECT e.organization_id, e.business_id, e.id, e.branch_id, true, 'permanent',
       COALESCE(e.hire_date, CURRENT_DATE),
       'Backfilled from employees.branch_id (Phase A)'
FROM public.employees e
WHERE e.branch_id IS NOT NULL
  AND e.business_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.employee_branch_assignments a
    WHERE a.employee_id = e.id AND a.effective_to IS NULL
  );

CREATE OR REPLACE VIEW public.v_employee_branch_scope AS
SELECT a.employee_id, a.branch_id
FROM public.employee_branch_assignments a
WHERE a.effective_to IS NULL
UNION ALL
SELECT e.id, NULL::uuid
FROM public.employees e
WHERE NOT EXISTS (
  SELECT 1 FROM public.employee_branch_assignments a
  WHERE a.employee_id = e.id AND a.effective_to IS NULL
);

GRANT SELECT ON public.v_employee_branch_scope TO authenticated, service_role;

-- Extend v_employees_canonical by APPENDING two new columns at the end
-- (CREATE OR REPLACE VIEW disallows renaming/reordering existing columns).
CREATE OR REPLACE VIEW public.v_employees_canonical AS
SELECT e.id,
       e.organization_id,
       e.business_id,
       e.branch_id,
       e.user_id, e.manager_id, e.department_id, e.department,
       e.job_position_id, e."position", e.work_location_id,
       e.employee_number, e.first_name, e.last_name, e.email, e.work_email,
       e.phone, e.hire_date, e.termination_date, e.employment_type,
       e.is_active, e.user_access_status, e.avatar_url, e.work_schedule_id,
       e.statutory_country_code, e.basic_salary, e.housing_allowance,
       e.transport_allowance, e.other_allowances, e.insurance_premium,
       e.cost_rate_override, e.labor_burden_pct, e.sms_consent,
       e.sms_consent_recorded_at, e.created_at, e.updated_at, e.created_by,
       e.department_name, e.position_title, e.active_contract_id,
       e.active_contract_wage, e.active_contract_housing_allowance,
       e.active_contract_transport_allowance,
       e.active_contract_other_allowances, e.active_contract_start_date,
       e.active_contract_end_date, e.national_id, e.date_of_birth,
       e.personal_phone, e.gender, e.marital_status, e.address_line1,
       e.address_line2, e.city, e.county, e.postal_code, e.country,
       e.emergency_contact_name, e.emergency_contact_phone,
       e.emergency_contact_relationship, e.bank_name, e.bank_branch,
       e.bank_account_number, e.bank_code, e.lifecycle_status,
       emp.lifecycle_status AS _lifecycle_status,
       emp.draft_owner_id AS _draft_owner_id,
       CASE emp.lifecycle_status::text
         WHEN 'draft'     THEN 'draft'
         WHEN 'active'    THEN 'active'
         WHEN 'on_leave'  THEN 'active'
         WHEN 'notice'    THEN 'active'
         WHEN 'suspended' THEN 'active'
         WHEN 'exited'    THEN 'exited'
         WHEN 'archived'  THEN 'archived'
         ELSE 'unknown'
       END AS lifecycle_bucket,
       emp.lifecycle_status::text <> ALL (ARRAY['draft','archived']) AS is_directory_visible,
       emp.lifecycle_status::text = ANY (ARRAY['active','on_leave','notice','suspended']) AS is_operationally_active,
       (emp.lifecycle_status::text = 'active' AND EXISTS (
          SELECT 1 FROM public.employee_contracts c
          WHERE c.employee_id = emp.id AND c.status = 'running'
       )) AS is_payroll_eligible,
       -- NEW: appended columns for Person/Assignment split
       (SELECT a.branch_id
          FROM public.employee_branch_assignments a
          WHERE a.employee_id = emp.id
            AND a.effective_to IS NULL
            AND a.is_primary = true
          LIMIT 1) AS primary_branch_id,
       COALESCE(
         (SELECT array_agg(a.branch_id)
            FROM public.employee_branch_assignments a
            WHERE a.employee_id = emp.id
              AND a.effective_to IS NULL),
         ARRAY[]::uuid[]
       ) AS branch_ids
FROM public.v_employees_safe e
JOIN public.employees emp ON emp.id = e.id;

GRANT SELECT ON public.v_employees_canonical TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._eba_sync_primary_to_employees(p_employee_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_primary uuid;
BEGIN
  SELECT branch_id INTO v_primary
  FROM public.employee_branch_assignments
  WHERE employee_id = p_employee_id
    AND effective_to IS NULL
    AND is_primary = true
  LIMIT 1;

  PERFORM set_config('app.eba_internal_write', 'on', true);
  UPDATE public.employees SET branch_id = v_primary, updated_at = now()
  WHERE id = p_employee_id;
  PERFORM set_config('app.eba_internal_write', 'off', true);
END $$;

CREATE OR REPLACE FUNCTION public._employees_branch_id_write_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id
     AND COALESCE(current_setting('app.eba_internal_write', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'employees.branch_id is now maintained via employee_branch_assignments. Use assign_employee_to_branch / transfer_employee_primary_branch.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_employees_branch_id_guard ON public.employees;
CREATE TRIGGER trg_employees_branch_id_guard
  BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public._employees_branch_id_write_guard();

CREATE OR REPLACE FUNCTION public.assign_employee_to_branch(
  p_employee_id uuid,
  p_branch_id uuid,
  p_is_primary boolean DEFAULT false,
  p_effective_from date DEFAULT CURRENT_DATE,
  p_assignment_type text DEFAULT 'permanent',
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid; v_biz uuid; v_branch_org uuid; v_branch_biz uuid; v_id uuid;
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin')
       OR public.has_role(auth.uid(),'owner')
       OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id, business_id INTO v_org, v_biz
  FROM public.employees WHERE id = p_employee_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'employee not found'; END IF;

  SELECT organization_id, business_id INTO v_branch_org, v_branch_biz
  FROM public.branches WHERE id = p_branch_id;
  IF v_branch_org IS NULL THEN RAISE EXCEPTION 'branch not found'; END IF;
  IF v_branch_org <> v_org OR (v_branch_biz IS NOT NULL AND v_branch_biz <> v_biz) THEN
    RAISE EXCEPTION 'branch belongs to a different business';
  END IF;

  IF p_is_primary THEN
    UPDATE public.employee_branch_assignments
       SET is_primary = false
     WHERE employee_id = p_employee_id
       AND effective_to IS NULL
       AND is_primary = true;
  END IF;

  INSERT INTO public.employee_branch_assignments
    (organization_id, business_id, employee_id, branch_id, is_primary,
     assignment_type, effective_from, notes, created_by)
  VALUES (v_org, v_biz, p_employee_id, p_branch_id, COALESCE(p_is_primary,false),
          COALESCE(p_assignment_type,'permanent'), COALESCE(p_effective_from,CURRENT_DATE),
          p_notes, auth.uid())
  RETURNING id INTO v_id;

  PERFORM public._eba_sync_primary_to_employees(p_employee_id);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.end_employee_branch_assignment(
  p_assignment_id uuid,
  p_effective_to date DEFAULT CURRENT_DATE
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_emp uuid;
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin')
       OR public.has_role(auth.uid(),'owner')
       OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;

  UPDATE public.employee_branch_assignments
     SET effective_to = COALESCE(p_effective_to, CURRENT_DATE),
         is_primary = false
   WHERE id = p_assignment_id AND effective_to IS NULL
  RETURNING employee_id INTO v_emp;

  IF v_emp IS NOT NULL THEN
    PERFORM public._eba_sync_primary_to_employees(v_emp);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.transfer_employee_primary_branch(
  p_employee_id uuid,
  p_new_branch_id uuid,
  p_effective_from date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_new_id uuid;
BEGIN
  IF NOT (public.has_role(auth.uid(),'admin')
       OR public.has_role(auth.uid(),'owner')
       OR public.has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'permission denied' USING ERRCODE = '42501';
  END IF;

  UPDATE public.employee_branch_assignments
     SET effective_to = COALESCE(p_effective_from, CURRENT_DATE) - INTERVAL '1 day',
         is_primary = false
   WHERE employee_id = p_employee_id
     AND effective_to IS NULL
     AND is_primary = true;

  v_new_id := public.assign_employee_to_branch(
    p_employee_id, p_new_branch_id, true,
    COALESCE(p_effective_from, CURRENT_DATE), 'permanent', p_notes);
  RETURN v_new_id;
END $$;

GRANT EXECUTE ON FUNCTION public.assign_employee_to_branch(uuid,uuid,boolean,date,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.end_employee_branch_assignment(uuid,date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transfer_employee_primary_branch(uuid,uuid,date,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._eba_sync_primary_to_employees(uuid) TO authenticated, service_role;
