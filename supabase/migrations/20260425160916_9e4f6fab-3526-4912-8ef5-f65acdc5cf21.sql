-- ============================================================
-- HR/Payroll + modular app entitlement hardening
-- Zero-trust follow-up after architecture audit
-- ============================================================

-- 1) Canonical dependency metadata: required vs optional/setup-only,
-- auto-install behavior, and billing behavior.
ALTER TABLE public.app_dependencies
  ADD COLUMN IF NOT EXISTS dependency_type text NOT NULL DEFAULT 'required',
  ADD COLUMN IF NOT EXISTS auto_install boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS billing_behavior text NOT NULL DEFAULT 'separate';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_dependencies_dependency_type_check'
  ) THEN
    ALTER TABLE public.app_dependencies
      ADD CONSTRAINT app_dependencies_dependency_type_check
      CHECK (dependency_type IN ('required', 'optional', 'setup_only'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_dependencies_billing_behavior_check'
  ) THEN
    ALTER TABLE public.app_dependencies
      ADD CONSTRAINT app_dependencies_billing_behavior_check
      CHECK (billing_behavior IN ('included', 'separate', 'free_foundation'));
  END IF;
END $$;

-- Ensure split HR-domain apps exist in DB registry.
INSERT INTO public.platform_apps (id, name, description, category, required_plan, is_available, is_free_trial, trial_days, sort_order, is_core, is_visible_in_signup)
VALUES
  ('employees', 'Employees', 'Employee directory, departments, contracts, and people analytics', 'hr', 'business', true, true, 14, 80, false, true),
  ('time-off', 'Time Off', 'Leave types, allocations, balances, requests, approvals, and reports', 'hr', 'business', true, true, 14, 81, false, true),
  ('attendance', 'Attendances', 'Clock-in/out, attendance oversight, work schedules, and overtime inputs', 'hr', 'business', true, true, 14, 82, false, true),
  ('timesheets', 'Timesheets', 'Employee and project time entries, approvals, and billing inputs', 'hr', 'business', true, true, 14, 83, false, true),
  ('payroll', 'Payroll', 'Contracts, salary rules, payroll runs, payslips, remittances, and accounting posting', 'hr', 'business', true, true, 14, 84, false, true),
  ('recruitment', 'Recruitment', 'Jobs, applicants, and hiring pipeline', 'hr', 'enterprise', false, false, 14, 85, false, false)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- Legacy `hr` means Employees only; never use it as a payroll entitlement.
INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by, is_active, settings, installed_at)
SELECT organization_id, 'employees', installed_by, is_active, settings, installed_at
FROM public.organization_installed_apps
WHERE app_id = 'hr'
ON CONFLICT (organization_id, app_id) DO NOTHING;

UPDATE public.organization_installed_apps
SET is_active = false, updated_at = now()
WHERE app_id = 'hr' AND is_active = true;

INSERT INTO public.plan_app_access (plan_id, app_id, is_enabled)
SELECT plan_id, 'employees', bool_or(COALESCE(is_enabled, true))
FROM public.plan_app_access
WHERE app_id = 'hr'
GROUP BY plan_id
ON CONFLICT (plan_id, app_id) DO UPDATE SET is_enabled = EXCLUDED.is_enabled;

DELETE FROM public.plan_app_access WHERE app_id = 'hr';

-- Rebuild HR dependency graph. Payroll requires Employees + Finance; Time Off,
-- Attendances, and Timesheets are optional payroll inputs, not hard install blockers.
DELETE FROM public.app_dependencies
WHERE app_id IN ('time-off', 'attendance', 'timesheets', 'payroll', 'recruitment')
   OR (app_id = 'payroll' AND depends_on_app_id IN ('time-off', 'attendance'));

INSERT INTO public.app_dependencies (app_id, depends_on_app_id, dependency_type, auto_install, billing_behavior)
VALUES
  ('time-off', 'employees', 'required', true, 'free_foundation'),
  ('attendance', 'employees', 'required', true, 'free_foundation'),
  ('timesheets', 'employees', 'required', true, 'free_foundation'),
  ('payroll', 'employees', 'required', true, 'free_foundation'),
  ('payroll', 'finance', 'required', true, 'separate'),
  ('payroll', 'time-off', 'optional', false, 'separate'),
  ('payroll', 'attendance', 'optional', false, 'separate'),
  ('payroll', 'timesheets', 'optional', false, 'separate'),
  ('recruitment', 'employees', 'setup_only', false, 'free_foundation')
ON CONFLICT (app_id, depends_on_app_id) DO UPDATE SET
  dependency_type = EXCLUDED.dependency_type,
  auto_install = EXCLUDED.auto_install,
  billing_behavior = EXCLUDED.billing_behavior;

-- 2) App access must consistently honor active trials and legacy hr alias.
CREATE OR REPLACE FUNCTION public.check_org_app_access(_org_id uuid, _app_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org RECORD;
  v_subscription_active boolean;
  v_override boolean;
  v_in_plan boolean;
  v_trial_active boolean;
  v_app text := CASE WHEN _app_id = 'hr' THEN 'employees' ELSE _app_id END;
BEGIN
  IF _org_id IS NULL OR v_app IS NULL OR v_app = '' THEN
    RETURN false;
  END IF;

  SELECT subscription_status, subscription_ends_at, trial_ends_at, is_suspended, subscription_plan_id AS plan_id
    INTO v_org
    FROM public.organizations
   WHERE id = _org_id;

  IF NOT FOUND OR COALESCE(v_org.is_suspended, false) THEN
    RETURN false;
  END IF;

  v_subscription_active :=
    v_org.subscription_status IS NULL OR
    (v_org.subscription_status = 'active' AND (v_org.subscription_ends_at IS NULL OR v_org.subscription_ends_at > now())) OR
    (v_org.subscription_status = 'trial' AND (v_org.trial_ends_at IS NULL OR v_org.trial_ends_at > now()));

  IF NOT v_subscription_active THEN
    RETURN false;
  END IF;

  SELECT (override_value)::text::boolean
    INTO v_override
    FROM public.org_entitlement_overrides
   WHERE organization_id = _org_id
     AND override_type = 'app'
     AND key = v_app
     AND COALESCE(is_active, true) = true
     AND (expires_at IS NULL OR expires_at > now())
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_override IS NOT NULL THEN
    RETURN v_override;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.app_trial_status
     WHERE organization_id = _org_id
       AND app_id = v_app
       AND status = 'active'
       AND expires_at > now()
  ) INTO v_trial_active;

  IF v_trial_active THEN
    RETURN true;
  END IF;

  IF v_org.plan_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT COALESCE(is_enabled, false)
    INTO v_in_plan
    FROM public.plan_app_access
   WHERE plan_id = v_org.plan_id
     AND app_id = v_app
   LIMIT 1;

  RETURN COALESCE(v_in_plan, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_org_app_installed(_org_id uuid, _app_id text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.organization_installed_apps
     WHERE organization_id = _org_id
       AND app_id = CASE WHEN _app_id = 'hr' THEN 'employees' ELSE _app_id END
       AND COALESCE(is_active, true) = true
  );
$function$;

CREATE OR REPLACE FUNCTION public.assert_entitlement(p_org_id uuid, p_app_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_app text := CASE WHEN p_app_id = 'hr' THEN 'employees' ELSE p_app_id END;
  v_app_name text;
BEGIN
  IF v_app = 'platform' THEN RETURN true; END IF;

  IF public.check_org_app_access(p_org_id, v_app) THEN
    RETURN true;
  END IF;

  SELECT name INTO v_app_name FROM public.platform_apps WHERE id = v_app;
  RAISE EXCEPTION 'ENTITLEMENT_REQUIRED: % is not included in your current plan. Upgrade or start a trial to use it.',
    COALESCE(v_app_name, v_app) USING ERRCODE = 'P0001', HINT = 'not_entitled';
END;
$function$;

-- 3) Permission defaults: self-service is handled by record policies, not broad
-- module grants. Access groups remain the elevation path.
CREATE OR REPLACE FUNCTION public.user_has_module_permission(
  _user_id uuid, _org_id uuid, _module text, _operation text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _role public.app_role;
  _user_type text;
  _group_grants boolean := false;
  _base_grants boolean := false;
  _mod text := CASE WHEN _module = 'hr' THEN 'employees' ELSE _module END;
BEGIN
  SELECT ur.role, ur.user_type INTO _role, _user_type
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id
    AND ur.organization_id = _org_id
    AND ur.is_active = true
  LIMIT 1;

  IF _role IS NULL THEN RETURN false; END IF;
  IF _role IN ('super_admin', 'owner', 'admin') THEN RETURN true; END IF;

  _base_grants := (
    CASE
      WHEN _mod = 'contacts' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer', 'cashier', 'internal')
      WHEN _mod = 'contacts' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'staff', 'internal')
      WHEN _mod = 'products' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer', 'cashier', 'internal')
      WHEN _mod = 'products' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('staff', 'internal')
      WHEN _mod = 'sales' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer', 'internal')
      WHEN _mod = 'sales' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'staff', 'internal')
      WHEN _mod = 'purchases' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer', 'internal')
      WHEN _mod = 'purchases' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'staff', 'internal')
      WHEN _mod = 'financials' AND _operation = 'read' THEN _role IN ('accountant', 'internal')
      WHEN _mod = 'financials' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'internal')
      WHEN _mod = 'employees' AND _operation = 'read' THEN _role IN ('internal')
      WHEN _mod = 'employees' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal')
      WHEN _mod = 'payroll' THEN false
      WHEN _mod = 'attendance' THEN false
      WHEN _mod IN ('timesheets', 'time-off', 'leave') THEN false
      WHEN _mod = 'recruitment' AND _operation = 'read' THEN _role IN ('internal')
      WHEN _mod = 'recruitment' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal')
      WHEN _mod = 'pos' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'cashier', 'internal')
      WHEN _mod = 'pos' AND _operation IN ('create', 'write') THEN _role IN ('staff', 'cashier', 'internal')
      WHEN _mod = 'pos' AND _operation = 'delete' THEN _role IN ('internal')
      WHEN _mod = 'projects' AND _operation = 'read' THEN _role IN ('internal', 'accountant', 'staff', 'viewer')
      WHEN _mod = 'projects' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal', 'accountant', 'staff')
      WHEN _mod = 'settings' AND _operation = 'read' THEN _role IN ('internal', 'accountant')
      WHEN _mod = 'team' AND _operation = 'read' THEN _role IN ('internal', 'accountant')
      ELSE false
    END
  );

  IF _user_type = 'portal' THEN
    _base_grants := false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id
      AND mpg.organization_id = _org_id
      AND (pgr.module = _mod OR (pgr.module = 'hr' AND _mod = 'employees'))
      AND ((_operation = 'read' AND pgr.can_read) OR (_operation = 'create' AND pgr.can_create) OR (_operation = 'write' AND pgr.can_write) OR (_operation = 'delete' AND pgr.can_delete))
  ) INTO _group_grants;

  RETURN _base_grants OR _group_grants;
END;
$function$;

-- 4) Tighten Attendance policies: self clock-in/out only, admin corrections via permission.
DROP POLICY IF EXISTS "Admin can delete attendance" ON public.attendance;
DROP POLICY IF EXISTS "Admin can update attendance" ON public.attendance;
DROP POLICY IF EXISTS "Self or admin can insert attendance" ON public.attendance;
DROP POLICY IF EXISTS "attendance_select_branch_scoped" ON public.attendance;
DROP POLICY IF EXISTS "Users can view own attendance" ON public.attendance;

CREATE POLICY "attendance_select_self_or_permission" ON public.attendance
FOR SELECT TO authenticated
USING (
  employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'attendance', 'read')
  )
);

CREATE POLICY "attendance_insert_self_or_permission" ON public.attendance
FOR INSERT TO authenticated
WITH CHECK (
  (
    employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
    AND COALESCE(clock_in_method, 'manual') IN ('self', 'web', 'kiosk', 'mobile', 'manual')
    AND approved_by IS NULL
    AND approved_at IS NULL
  )
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'attendance', 'create')
  )
);

CREATE POLICY "attendance_update_self_clockout_or_permission" ON public.attendance
FOR UPDATE TO authenticated
USING (
  (
    employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
    AND approved_by IS NULL
  )
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'attendance', 'write')
  )
)
WITH CHECK (
  (
    employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
    AND approved_by IS NULL
  )
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'attendance', 'write')
  )
);

CREATE POLICY "attendance_delete_permission" ON public.attendance
FOR DELETE TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'attendance', 'delete')
);

-- 5) Tighten Timesheets / submissions: no more org-wide manage/read.
DROP POLICY IF EXISTS "Users can manage timesheets in their organization" ON public.timesheets;
DROP POLICY IF EXISTS "Users can view timesheets in their organization" ON public.timesheets;
DROP POLICY IF EXISTS "Users can manage timesheet submissions in their organization" ON public.timesheet_submissions;
DROP POLICY IF EXISTS "Users can view timesheet submissions in their organization" ON public.timesheet_submissions;

CREATE POLICY "timesheets_select_self_manager_or_permission" ON public.timesheets
FOR SELECT TO authenticated
USING (
  employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  OR employee_id IN (SELECT id FROM public.employees WHERE manager_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()))
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'timesheets', 'read')
  )
);

CREATE POLICY "timesheets_insert_self_or_permission" ON public.timesheets
FOR INSERT TO authenticated
WITH CHECK (
  employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'timesheets', 'create')
  )
);

CREATE POLICY "timesheets_update_self_draft_or_permission" ON public.timesheets
FOR UPDATE TO authenticated
USING (
  (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()) AND status IN ('draft', 'rejected'))
  OR employee_id IN (SELECT id FROM public.employees WHERE manager_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()))
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'timesheets', 'write')
  )
)
WITH CHECK (
  (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()) AND status IN ('draft', 'submitted', 'rejected'))
  OR employee_id IN (SELECT id FROM public.employees WHERE manager_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()))
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'timesheets', 'write')
  )
);

CREATE POLICY "timesheets_delete_self_draft_or_permission" ON public.timesheets
FOR DELETE TO authenticated
USING (
  (employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()) AND status IN ('draft', 'rejected'))
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'timesheets', 'delete')
  )
);

CREATE POLICY "timesheet_submissions_select_self_manager_or_permission" ON public.timesheet_submissions
FOR SELECT TO authenticated
USING (
  employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  OR employee_id IN (SELECT id FROM public.employees WHERE manager_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()))
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'timesheets', 'read')
  )
);

CREATE POLICY "timesheet_submissions_insert_self_or_permission" ON public.timesheet_submissions
FOR INSERT TO authenticated
WITH CHECK (
  employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'timesheets', 'create')
  )
);

CREATE POLICY "timesheet_submissions_update_manager_or_permission" ON public.timesheet_submissions
FOR UPDATE TO authenticated
USING (
  employee_id IN (SELECT id FROM public.employees WHERE manager_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()))
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'timesheets', 'write')
  )
)
WITH CHECK (
  employee_id IN (SELECT id FROM public.employees WHERE manager_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid()))
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'timesheets', 'write')
  )
);

CREATE POLICY "timesheet_submissions_delete_permission" ON public.timesheet_submissions
FOR DELETE TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'timesheets', 'delete')
);

-- 6) Payroll readiness: selected employees must have active contracts covering period.
CREATE OR REPLACE FUNCTION public.assert_payroll_ready(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL,
  p_employee_ids uuid[] DEFAULT NULL,
  p_period_start date DEFAULT NULL,
  p_period_end date DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_missing_contracts int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.installed_localization_packs WHERE organization_id = p_org_id) THEN
    v_missing := array_append(v_missing, 'localization pack');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.salary_structures WHERE organization_id = p_org_id AND is_active = true) THEN
    v_missing := array_append(v_missing, 'salary structure');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_account_mappings
    WHERE organization_id = p_org_id
      AND is_active = true
      AND (p_business_id IS NULL OR business_id IS NULL OR business_id = p_business_id)
  ) THEN
    v_missing := array_append(v_missing, 'payroll account mappings');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_statutory_rules
    WHERE organization_id = p_org_id
      AND is_active = true
      AND (effective_to IS NULL OR effective_to >= COALESCE(p_period_end, CURRENT_DATE))
  ) THEN
    v_missing := array_append(v_missing, 'statutory rules');
  END IF;

  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.employee_contracts
      WHERE organization_id = p_org_id
        AND status IN ('running', 'new', 'active')
        AND (p_business_id IS NULL OR business_id = p_business_id)
    ) THEN
      v_missing := array_append(v_missing, 'active employee contract');
    END IF;
  ELSE
    SELECT count(*) INTO v_missing_contracts
    FROM unnest(p_employee_ids) AS selected(employee_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.employee_contracts ec
      WHERE ec.organization_id = p_org_id
        AND ec.employee_id = selected.employee_id
        AND ec.status IN ('running', 'new', 'active')
        AND (p_business_id IS NULL OR ec.business_id = p_business_id)
        AND (p_period_end IS NULL OR ec.start_date <= p_period_end)
        AND (p_period_start IS NULL OR ec.end_date IS NULL OR ec.end_date >= p_period_start)
    );

    IF v_missing_contracts > 0 THEN
      v_missing := array_append(v_missing, v_missing_contracts || ' selected employee(s) without active period contract');
    END IF;
  END IF;

  IF array_length(v_missing, 1) IS NULL THEN
    RETURN true;
  END IF;

  RAISE EXCEPTION 'SETUP_REQUIRED: Payroll cannot run yet. Missing: %.', array_to_string(v_missing, ', ')
    USING ERRCODE = 'P0001', HINT = 'payroll_setup_incomplete';
END;
$function$;

CREATE OR REPLACE FUNCTION public.assert_payroll_ready(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.assert_payroll_ready(p_org_id, NULL::uuid, NULL::uuid[], NULL::date, NULL::date);
$function$;

CREATE OR REPLACE FUNCTION public.refresh_payroll_setup_status(p_org_id uuid, p_business_id uuid DEFAULT NULL)
RETURNS public.app_setup_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reasons jsonb := '[]'::jsonb;
  v_row public.app_setup_status;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.installed_localization_packs WHERE organization_id = p_org_id) THEN
    v_reasons := v_reasons || jsonb_build_array('localization pack');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.salary_structures WHERE organization_id = p_org_id AND is_active = true) THEN
    v_reasons := v_reasons || jsonb_build_array('salary structure');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payroll_account_mappings WHERE organization_id = p_org_id AND is_active = true AND (p_business_id IS NULL OR business_id IS NULL OR business_id = p_business_id)) THEN
    v_reasons := v_reasons || jsonb_build_array('payroll account mappings');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payroll_statutory_rules WHERE organization_id = p_org_id AND is_active = true AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)) THEN
    v_reasons := v_reasons || jsonb_build_array('statutory rules');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employee_contracts WHERE organization_id = p_org_id AND status IN ('running', 'new', 'active') AND (p_business_id IS NULL OR business_id = p_business_id)) THEN
    v_reasons := v_reasons || jsonb_build_array('active employee contract');
  END IF;

  INSERT INTO public.app_setup_status (organization_id, app_id, status, blocking_reasons, last_checked_at)
  VALUES (p_org_id, 'payroll', CASE WHEN jsonb_array_length(v_reasons) = 0 THEN 'ready' ELSE 'incomplete' END, v_reasons, now())
  ON CONFLICT (organization_id, app_id) DO UPDATE SET
    status = EXCLUDED.status,
    blocking_reasons = EXCLUDED.blocking_reasons,
    last_checked_at = now(),
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.check_org_app_access(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_org_app_installed(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_entitlement(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_payroll_ready(uuid, uuid, uuid[], date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_payroll_ready(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.refresh_payroll_setup_status(uuid, uuid) TO authenticated, service_role;