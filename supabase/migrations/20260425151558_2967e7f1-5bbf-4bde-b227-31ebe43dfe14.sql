-- =====================================================================
-- PHASE A — HR/Payroll architectural foundation
-- =====================================================================
-- Order matters: helper functions first, then new tables, then RLS rewrites,
-- then data sweeps, then plan reseed. Every drop is preceded by a replacement.

-- ---------------------------------------------------------------------
-- 1. user_has_module_permission: alias 'hr' → 'employees', tighten payroll
-- ---------------------------------------------------------------------
-- Goal: payroll/employees compensation permissions stop leaking to 'accountant'.
-- 'accountant' keeps Finance read on payroll JOURNALS via the financials module
-- (separately checked at the journal_entries policy layer), but cannot read
-- raw salary fields off contracts/payslips.
-- 'hr' string is preserved for back-compat by aliasing to 'employees'.

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
  _mod text := _module;
BEGIN
  -- Back-compat: 'hr' is the old bundled name for 'employees'
  IF _mod = 'hr' THEN _mod := 'employees'; END IF;

  SELECT ur.role, ur.user_type INTO _role, _user_type
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id
    AND ur.organization_id = _org_id
    AND ur.is_active = true
  LIMIT 1;

  IF _role IS NULL THEN
    RETURN false;
  END IF;

  IF _role IN ('super_admin', 'owner', 'admin') THEN
    RETURN true;
  END IF;

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

      -- Employees: HR data (no compensation). 'internal' = HR-equivalent base role.
      -- Accountants do NOT get base read on employees/contracts (compensation privacy).
      WHEN _mod = 'employees' AND _operation = 'read' THEN _role IN ('internal')
      WHEN _mod = 'employees' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal')

      -- Payroll: money-touching. NO base grants for accountants.
      -- Accountants get GL view via 'financials' on journal_entries instead.
      -- Group rules (e.g. "Payroll Officer") elevate specific users.
      WHEN _mod = 'payroll' AND _operation = 'read' THEN false
      WHEN _mod = 'payroll' AND _operation IN ('create', 'write', 'delete') THEN false

      WHEN _mod = 'pos' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'cashier', 'internal')
      WHEN _mod = 'pos' AND _operation IN ('create', 'write') THEN _role IN ('staff', 'cashier', 'internal')
      WHEN _mod = 'pos' AND _operation = 'delete' THEN _role IN ('internal')

      WHEN _mod = 'leave' AND _operation = 'read' THEN true
      WHEN _mod = 'leave' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal', 'accountant')
      WHEN _mod = 'time-off' AND _operation = 'read' THEN true
      WHEN _mod = 'time-off' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal')

      WHEN _mod = 'attendance' AND _operation = 'read' THEN _role IN ('internal', 'accountant', 'staff')
      WHEN _mod = 'attendance' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal')

      WHEN _mod = 'recruitment' AND _operation = 'read' THEN _role IN ('internal')
      WHEN _mod = 'recruitment' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal')

      WHEN _mod = 'timesheets' AND _operation = 'read' THEN true
      WHEN _mod = 'timesheets' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal', 'accountant', 'staff')
      WHEN _mod = 'projects' AND _operation = 'read' THEN _role IN ('internal', 'accountant', 'staff', 'viewer')
      WHEN _mod = 'projects' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal', 'accountant', 'staff')
      WHEN _mod = 'settings' AND _operation = 'read' THEN _role IN ('internal', 'accountant')
      WHEN _mod = 'settings' AND _operation IN ('create', 'write', 'delete') THEN false
      WHEN _mod = 'team' AND _operation = 'read' THEN _role IN ('internal', 'accountant')
      WHEN _mod = 'team' AND _operation IN ('create', 'write', 'delete') THEN false
      ELSE false
    END
  );

  IF _user_type = 'portal' THEN
    IF _mod NOT IN ('leave', 'time-off', 'timesheets', 'projects', 'attendance') THEN
      RETURN false;
    END IF;
    _base_grants := false;
  END IF;

  -- Group grants: also apply 'hr' → 'employees' alias inside the lookup
  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id
      AND mpg.organization_id = _org_id
      AND (pgr.module = _mod OR (pgr.module = 'hr' AND _mod = 'employees'))
      AND (
        (_operation = 'read' AND pgr.can_read = true) OR
        (_operation = 'create' AND pgr.can_create = true) OR
        (_operation = 'write' AND pgr.can_write = true) OR
        (_operation = 'delete' AND pgr.can_delete = true)
      )
  ) INTO _group_grants;

  RETURN _base_grants OR _group_grants;
END;
$function$;

-- ---------------------------------------------------------------------
-- 2. payslips: branch-scope policies (replace org-only versions)
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "payslips_select_perm" ON public.payslips;
DROP POLICY IF EXISTS "payslips_insert_perm" ON public.payslips;
DROP POLICY IF EXISTS "payslips_update_perm" ON public.payslips;
DROP POLICY IF EXISTS "payslips_delete_perm" ON public.payslips;

CREATE POLICY "payslips_select_branch_scoped" ON public.payslips
FOR SELECT TO authenticated
USING (
  -- Employee can always see their own payslips
  employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read')
  )
);

CREATE POLICY "payslips_insert_branch_scoped" ON public.payslips
FOR INSERT TO authenticated
WITH CHECK (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'create')
);

CREATE POLICY "payslips_update_branch_scoped" ON public.payslips
FOR UPDATE TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
)
WITH CHECK (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
);

CREATE POLICY "payslips_delete_branch_scoped" ON public.payslips
FOR DELETE TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'delete')
);

-- ---------------------------------------------------------------------
-- 3. payroll_remittances: branch-scope replaces "Finance users" all-org policy
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view remittances in their org" ON public.payroll_remittances;
DROP POLICY IF EXISTS "Finance users can insert remittances" ON public.payroll_remittances;
DROP POLICY IF EXISTS "Finance users can update remittances" ON public.payroll_remittances;

CREATE POLICY "payroll_remittances_select_branch_scoped" ON public.payroll_remittances
FOR SELECT TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read')
);

CREATE POLICY "payroll_remittances_insert_branch_scoped" ON public.payroll_remittances
FOR INSERT TO authenticated
WITH CHECK (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'create')
);

CREATE POLICY "payroll_remittances_update_branch_scoped" ON public.payroll_remittances
FOR UPDATE TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
)
WITH CHECK (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
);

-- ---------------------------------------------------------------------
-- 4. employee_loans: branch-scope replaces org-only policies
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view loans in their org" ON public.employee_loans;
DROP POLICY IF EXISTS "Users with managePayroll can manage loans" ON public.employee_loans;

CREATE POLICY "employee_loans_select_branch_scoped" ON public.employee_loans
FOR SELECT TO authenticated
USING (
  -- Employee sees their own loans
  employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read')
  )
);

CREATE POLICY "employee_loans_insert_branch_scoped" ON public.employee_loans
FOR INSERT TO authenticated
WITH CHECK (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'create')
);

CREATE POLICY "employee_loans_update_branch_scoped" ON public.employee_loans
FOR UPDATE TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
)
WITH CHECK (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
);

CREATE POLICY "employee_loans_delete_branch_scoped" ON public.employee_loans
FOR DELETE TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'delete')
);

-- ---------------------------------------------------------------------
-- 5. payroll_account_mappings: branch-scope replaces org-only policies
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view mappings in their org" ON public.payroll_account_mappings;
DROP POLICY IF EXISTS "Users with managePayroll can manage mappings" ON public.payroll_account_mappings;

CREATE POLICY "payroll_mappings_select_branch_scoped" ON public.payroll_account_mappings
FOR SELECT TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read')
);

CREATE POLICY "payroll_mappings_insert_branch_scoped" ON public.payroll_account_mappings
FOR INSERT TO authenticated
WITH CHECK (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'create')
);

CREATE POLICY "payroll_mappings_update_branch_scoped" ON public.payroll_account_mappings
FOR UPDATE TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
)
WITH CHECK (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
);

CREATE POLICY "payroll_mappings_delete_branch_scoped" ON public.payroll_account_mappings
FOR DELETE TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'delete')
);

-- ---------------------------------------------------------------------
-- 6. employee_contracts: drop accountant-sees-salary; tighten to payroll module
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "HR and payroll can view all contracts" ON public.employee_contracts;
DROP POLICY IF EXISTS "Users with manageEmployees can insert contracts" ON public.employee_contracts;
DROP POLICY IF EXISTS "Users with manageEmployees can update contracts" ON public.employee_contracts;
DROP POLICY IF EXISTS "Users with manageEmployees can delete contracts" ON public.employee_contracts;

CREATE POLICY "employee_contracts_select_compensation_safe" ON public.employee_contracts
FOR SELECT TO authenticated
USING (
  -- Employee can see their own contract
  employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  OR (
    business_id IS NOT NULL
    AND public.user_can_access_business(auth.uid(), business_id)
    AND (
      public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'read')
      OR public.user_has_module_permission(auth.uid(), organization_id, business_id, 'employees', 'write')
    )
  )
);

CREATE POLICY "employee_contracts_insert_branch_scoped" ON public.employee_contracts
FOR INSERT TO authenticated
WITH CHECK (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND (
    public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'create')
    OR public.user_has_module_permission(auth.uid(), organization_id, business_id, 'employees', 'create')
  )
);

CREATE POLICY "employee_contracts_update_branch_scoped" ON public.employee_contracts
FOR UPDATE TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND (
    public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
    OR public.user_has_module_permission(auth.uid(), organization_id, business_id, 'employees', 'write')
  )
)
WITH CHECK (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND (
    public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'write')
    OR public.user_has_module_permission(auth.uid(), organization_id, business_id, 'employees', 'write')
  )
);

CREATE POLICY "employee_contracts_delete_branch_scoped" ON public.employee_contracts
FOR DELETE TO authenticated
USING (
  business_id IS NOT NULL
  AND public.user_can_access_business(auth.uid(), business_id)
  AND public.user_has_module_permission(auth.uid(), organization_id, business_id, 'payroll', 'delete')
);

-- ---------------------------------------------------------------------
-- 7. attendance: tighten admin-sees-everything; let attendance-permission users see branch
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own attendance" ON public.attendance;

CREATE POLICY "attendance_select_branch_scoped" ON public.attendance
FOR SELECT TO authenticated
USING (
  -- Self
  employee_id IN (SELECT id FROM public.employees WHERE user_id = auth.uid())
  OR (
    -- Branch-scoped attendance permission. Joins via employees because attendance
    -- doesn't carry business_id directly.
    employee_id IN (
      SELECT e.id FROM public.employees e
      WHERE public.user_can_access_business(auth.uid(), e.business_id)
        AND public.user_has_module_permission(auth.uid(), e.organization_id, e.business_id, 'attendance', 'read')
    )
  )
);

-- ---------------------------------------------------------------------
-- 8. Sweep legacy organization_installed_apps rows: 'hr' → 'employees'
-- ---------------------------------------------------------------------
-- ON CONFLICT keeps the older row if both exist (preserves installed_at).
INSERT INTO public.organization_installed_apps (organization_id, app_id, installed_by, is_active, settings, installed_at)
SELECT organization_id, 'employees', installed_by, is_active, settings, installed_at
FROM public.organization_installed_apps
WHERE app_id = 'hr'
ON CONFLICT (organization_id, app_id) DO NOTHING;

UPDATE public.organization_installed_apps SET is_active = false WHERE app_id = 'hr';

-- Same for plan_app_access
INSERT INTO public.plan_app_access (plan_id, app_id)
SELECT plan_id, 'employees' FROM public.plan_app_access WHERE app_id = 'hr'
ON CONFLICT DO NOTHING;
DELETE FROM public.plan_app_access WHERE app_id = 'hr';

-- ---------------------------------------------------------------------
-- 9. New table: app_pricing_rules (platform-admin editable)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL REFERENCES public.platform_apps(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'USD',
  monthly_price numeric NOT NULL DEFAULT 0,
  yearly_price numeric NOT NULL DEFAULT 0,
  is_per_user boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, currency)
);

ALTER TABLE public.app_pricing_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "app_pricing_rules_public_read" ON public.app_pricing_rules
FOR SELECT TO authenticated USING (is_active = true);

CREATE POLICY "app_pricing_rules_platform_admin_write" ON public.app_pricing_rules
FOR ALL TO authenticated
USING (public.has_platform_permission(auth.uid(), 'manage_billing'))
WITH CHECK (public.has_platform_permission(auth.uid(), 'manage_billing'));

-- ---------------------------------------------------------------------
-- 10. New table: app_trial_status (per-tenant per-app trial)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_trial_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES public.platform_apps(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  converted_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'converted', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_app_trial_status_org ON public.app_trial_status(organization_id);
CREATE INDEX IF NOT EXISTS idx_app_trial_status_expires ON public.app_trial_status(expires_at) WHERE status = 'active';

ALTER TABLE public.app_trial_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "app_trial_status_org_read" ON public.app_trial_status
FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "app_trial_status_admin_manage" ON public.app_trial_status
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND organization_id = app_trial_status.organization_id
      AND role IN ('owner', 'admin')
      AND is_active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND organization_id = app_trial_status.organization_id
      AND role IN ('owner', 'admin')
      AND is_active = true
  )
);

-- ---------------------------------------------------------------------
-- 11. New table: app_setup_status (per-tenant per-app readiness)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_setup_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  app_id text NOT NULL REFERENCES public.platform_apps(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'incomplete', 'ready')),
  blocking_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, app_id)
);

ALTER TABLE public.app_setup_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "app_setup_status_org_read" ON public.app_setup_status
FOR SELECT TO authenticated
USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() AND is_active = true));

CREATE POLICY "app_setup_status_admin_write" ON public.app_setup_status
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND organization_id = app_setup_status.organization_id
      AND role IN ('owner', 'admin')
      AND is_active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid()
      AND organization_id = app_setup_status.organization_id
      AND role IN ('owner', 'admin')
      AND is_active = true
  )
);

-- ---------------------------------------------------------------------
-- 12. assert_entitlement: backend-authoritative entitlement check
-- ---------------------------------------------------------------------
-- Used by edge functions and RPCs before doing app-specific work.
-- An org is entitled to an app if any of:
--   (a) their plan bundles the app via plan_app_access
--   (b) an active app_trial_status row exists
--   (c) an active org_entitlement_overrides row grants it (override_type='app')
-- Returns true; raises P0001 with structured ENTITLEMENT_REQUIRED message otherwise.

CREATE OR REPLACE FUNCTION public.assert_entitlement(p_org_id uuid, p_app_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_plan_id uuid;
  v_in_plan boolean;
  v_trial_active boolean;
  v_overridden boolean;
  v_app_name text;
BEGIN
  -- Always allow the platform/settings app
  IF p_app_id = 'platform' THEN RETURN true; END IF;

  -- 1. Plan inclusion
  SELECT subscription_plan_id INTO v_plan_id FROM public.organizations WHERE id = p_org_id;
  IF v_plan_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.plan_app_access
      WHERE plan_id = v_plan_id AND app_id = p_app_id
    ) INTO v_in_plan;
    IF v_in_plan THEN RETURN true; END IF;
  END IF;

  -- 2. Active trial
  SELECT EXISTS (
    SELECT 1 FROM public.app_trial_status
    WHERE organization_id = p_org_id
      AND app_id = p_app_id
      AND status = 'active'
      AND expires_at > now()
  ) INTO v_trial_active;
  IF v_trial_active THEN RETURN true; END IF;

  -- 3. Per-tenant override
  SELECT EXISTS (
    SELECT 1 FROM public.org_entitlement_overrides
    WHERE organization_id = p_org_id
      AND override_type = 'app'
      AND key = p_app_id
      AND is_active = true
      AND (expires_at IS NULL OR expires_at > now())
  ) INTO v_overridden;
  IF v_overridden THEN RETURN true; END IF;

  SELECT name INTO v_app_name FROM public.platform_apps WHERE id = p_app_id;
  RAISE EXCEPTION 'ENTITLEMENT_REQUIRED: % is not included in your current plan. Upgrade or start a trial to use it.',
    COALESCE(v_app_name, p_app_id) USING ERRCODE = 'P0001', HINT = 'not_entitled';
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_entitlement(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 13. assert_payroll_ready: hard gate before any payroll run
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_payroll_ready(p_org_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  -- Localization pack
  IF NOT EXISTS (
    SELECT 1 FROM public.installed_localization_packs
    WHERE organization_id = p_org_id
  ) THEN
    v_missing := array_append(v_missing, 'localization pack');
  END IF;

  -- At least one salary structure
  IF NOT EXISTS (
    SELECT 1 FROM public.salary_structures
    WHERE organization_id = p_org_id AND is_active = true
  ) THEN
    v_missing := array_append(v_missing, 'salary structure');
  END IF;

  -- Payroll account mappings must exist
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_account_mappings
    WHERE organization_id = p_org_id AND is_active = true
  ) THEN
    v_missing := array_append(v_missing, 'payroll account mappings');
  END IF;

  -- Active statutory rules
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_statutory_rules
    WHERE organization_id = p_org_id AND is_active = true
      AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  ) THEN
    v_missing := array_append(v_missing, 'statutory rules');
  END IF;

  -- At least one active employee contract
  IF NOT EXISTS (
    SELECT 1 FROM public.employee_contracts
    WHERE organization_id = p_org_id AND status = 'active'
  ) THEN
    v_missing := array_append(v_missing, 'active employee contract');
  END IF;

  IF array_length(v_missing, 1) IS NULL THEN
    RETURN true;
  END IF;

  RAISE EXCEPTION 'SETUP_REQUIRED: Payroll cannot run yet. Missing: %.',
    array_to_string(v_missing, ', ')
    USING ERRCODE = 'P0001', HINT = 'payroll_setup_incomplete';
END;
$$;

GRANT EXECUTE ON FUNCTION public.assert_payroll_ready(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 14. Reseed plan_app_access into real bundles
-- ---------------------------------------------------------------------
-- Wipe and reinsert. Plan IDs come from platform_subscription_plans (verified live).
DELETE FROM public.plan_app_access;

-- Free plan: core finance + sales + reports + platform
INSERT INTO public.plan_app_access (plan_id, app_id) VALUES
  ('72cbf130-6de2-4f6d-9cbb-b736ff8452d8','finance'),
  ('72cbf130-6de2-4f6d-9cbb-b736ff8452d8','sales'),
  ('72cbf130-6de2-4f6d-9cbb-b736ff8452d8','contacts'),
  ('72cbf130-6de2-4f6d-9cbb-b736ff8452d8','purchases'),
  ('72cbf130-6de2-4f6d-9cbb-b736ff8452d8','reports'),
  ('72cbf130-6de2-4f6d-9cbb-b736ff8452d8','platform');

-- Growth: Free + inventory + productivity tooling + sms
INSERT INTO public.plan_app_access (plan_id, app_id) VALUES
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','finance'),
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','sales'),
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','contacts'),
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','purchases'),
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','reports'),
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','platform'),
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','inventory'),
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','documents'),
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','sign'),
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','spreadsheets'),
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','studio'),
  ('573f3b28-a287-4d1f-bf02-eb5455824e67','sms');

-- Business: Growth + pos + crm + projects + Employees/Time-off/Attendance/Payroll
INSERT INTO public.plan_app_access (plan_id, app_id) VALUES
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','finance'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','sales'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','contacts'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','purchases'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','reports'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','platform'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','inventory'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','documents'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','sign'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','spreadsheets'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','studio'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','sms'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','pos'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','crm'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','projects'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','employees'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','time-off'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','attendance'),
  ('3e4fbab0-3652-43c7-85db-f2dbe0d66884','payroll');

-- Enterprise: Business + recruitment (everything)
INSERT INTO public.plan_app_access (plan_id, app_id) VALUES
  ('2e45711a-cdae-43ee-97a1-138c83010206','finance'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','sales'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','contacts'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','purchases'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','reports'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','platform'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','inventory'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','documents'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','sign'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','spreadsheets'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','studio'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','sms'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','pos'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','crm'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','projects'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','employees'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','time-off'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','attendance'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','payroll'),
  ('2e45711a-cdae-43ee-97a1-138c83010206','recruitment');

-- ---------------------------------------------------------------------
-- 15. Seed default app_pricing_rules so platform-admin UI has rows to edit
-- ---------------------------------------------------------------------
-- Per-app overage pricing in USD. Roughly aligned to Odoo's "buy a single app"
-- pricing tier (~$8-15 per app/month). Platform admin can edit later.
INSERT INTO public.app_pricing_rules (app_id, currency, monthly_price, yearly_price, is_per_user)
SELECT id, 'USD',
  CASE
    WHEN id IN ('payroll','pos') THEN 15
    WHEN id IN ('crm','projects','employees','attendance','time-off','recruitment') THEN 10
    WHEN id IN ('inventory','documents','sign','spreadsheets','studio','sms') THEN 8
    ELSE 0
  END,
  CASE
    WHEN id IN ('payroll','pos') THEN 150
    WHEN id IN ('crm','projects','employees','attendance','time-off','recruitment') THEN 100
    WHEN id IN ('inventory','documents','sign','spreadsheets','studio','sms') THEN 80
    ELSE 0
  END,
  false
FROM public.platform_apps
WHERE is_available = true AND id <> 'platform'
ON CONFLICT (app_id, currency) DO NOTHING;

-- ---------------------------------------------------------------------
-- 16. updated_at triggers for the new tables
-- ---------------------------------------------------------------------
CREATE TRIGGER set_app_pricing_rules_updated_at
BEFORE UPDATE ON public.app_pricing_rules
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_app_trial_status_updated_at
BEFORE UPDATE ON public.app_trial_status
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_app_setup_status_updated_at
BEFORE UPDATE ON public.app_setup_status
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();