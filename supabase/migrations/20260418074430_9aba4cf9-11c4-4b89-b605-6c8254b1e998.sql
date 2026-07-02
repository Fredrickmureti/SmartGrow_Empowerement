
-- ============================================================================
-- 1. UNION-based permission resolution (additive)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.user_has_module_permission(
  _user_id uuid,
  _org_id uuid,
  _module text,
  _operation text
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
BEGIN
  -- 1. Get user's role and type in this org
  SELECT ur.role, ur.user_type INTO _role, _user_type
  FROM public.user_roles ur
  WHERE ur.user_id = _user_id 
    AND ur.organization_id = _org_id 
    AND ur.is_active = true
  LIMIT 1;

  -- No active role found = no access
  IF _role IS NULL THEN
    RETURN false;
  END IF;

  -- 2. Owner/admin/super_admin always pass (sacred shortcut)
  IF _role IN ('super_admin', 'owner', 'admin') THEN
    RETURN true;
  END IF;

  -- 3. Compute base-role grants (Odoo-style baseline)
  _base_grants := (
    CASE 
      WHEN _module = 'contacts' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer', 'cashier', 'internal')
      WHEN _module = 'contacts' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'staff', 'internal')
      WHEN _module = 'products' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer', 'cashier', 'internal')
      WHEN _module = 'products' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('staff', 'internal')
      WHEN _module = 'sales' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer', 'internal')
      WHEN _module = 'sales' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'staff', 'internal')
      WHEN _module = 'purchases' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'viewer', 'internal')
      WHEN _module = 'purchases' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'staff', 'internal')
      WHEN _module = 'financials' AND _operation = 'read' THEN _role IN ('accountant', 'internal')
      WHEN _module = 'financials' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'internal')
      WHEN _module = 'hr' AND _operation = 'read' THEN _role IN ('accountant', 'internal')
      WHEN _module = 'hr' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal')
      WHEN _module = 'payroll' AND _operation = 'read' THEN _role IN ('accountant', 'internal')
      WHEN _module = 'payroll' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('accountant', 'internal')
      WHEN _module = 'pos' AND _operation = 'read' THEN _role IN ('accountant', 'staff', 'cashier', 'internal')
      WHEN _module = 'pos' AND _operation IN ('create', 'write') THEN _role IN ('staff', 'cashier', 'internal')
      WHEN _module = 'pos' AND _operation = 'delete' THEN _role IN ('internal')
      WHEN _module = 'leave' AND _operation = 'read' THEN true
      WHEN _module = 'leave' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal', 'accountant')
      WHEN _module = 'timesheets' AND _operation = 'read' THEN true
      WHEN _module = 'timesheets' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal', 'accountant', 'staff')
      WHEN _module = 'projects' AND _operation = 'read' THEN _role IN ('internal', 'accountant', 'staff', 'viewer')
      WHEN _module = 'projects' AND _operation IN ('create', 'write', 'delete') THEN _role IN ('internal', 'accountant', 'staff')
      WHEN _module = 'settings' AND _operation = 'read' THEN _role IN ('internal', 'accountant')
      WHEN _module = 'settings' AND _operation IN ('create', 'write', 'delete') THEN false
      WHEN _module = 'team' AND _operation = 'read' THEN _role IN ('internal', 'accountant')
      WHEN _module = 'team' AND _operation IN ('create', 'write', 'delete') THEN false
      ELSE false
    END
  );

  -- 4. Portal users: ONLY allowed via groups, restricted to leave/timesheets/projects
  IF _user_type = 'portal' THEN
    IF _module NOT IN ('leave', 'timesheets', 'projects') THEN
      RETURN false;
    END IF;
    -- Fall through to group check (no base grants for portal)
    _base_grants := false;
  END IF;

  -- 5. Compute group-level grants
  SELECT EXISTS (
    SELECT 1
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = _user_id 
      AND mpg.organization_id = _org_id
      AND pgr.module = _module
      AND (
        (_operation = 'read' AND pgr.can_read = true) OR
        (_operation = 'create' AND pgr.can_create = true) OR
        (_operation = 'write' AND pgr.can_write = true) OR
        (_operation = 'delete' AND pgr.can_delete = true)
      )
  ) INTO _group_grants;

  -- 6. UNION: base OR group grants access (groups can only ELEVATE, never REMOVE)
  RETURN _base_grants OR _group_grants;
END;
$function$;

-- ============================================================================
-- 2. Single-owner unique partial index
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_one_active_owner_per_org
  ON public.user_roles(organization_id)
  WHERE role = 'owner' AND is_active = true;

-- ============================================================================
-- 3. Updated seeder: include Payroll Admin / Payroll Officer / Accountant
-- ============================================================================
CREATE OR REPLACE FUNCTION public.seed_default_permission_groups(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  portal_group_id UUID;
  internal_group_id UUID;
  payroll_admin_id UUID;
  payroll_officer_id UUID;
  accountant_id UUID;
BEGIN
  -- Portal User
  SELECT id INTO portal_group_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Portal User' AND is_system = true;
  IF portal_group_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Portal User', 'Self-service access: view payslips, request leave, submit timesheets', true)
    RETURNING id INTO portal_group_id;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
      (portal_group_id, 'leave', true, true, false, false),
      (portal_group_id, 'timesheets', true, true, false, false),
      (portal_group_id, 'projects', true, false, false, false);
  END IF;

  -- Internal User (full access baseline)
  SELECT id INTO internal_group_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Internal User' AND is_system = true;
  IF internal_group_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Internal User', 'Default group for internal staff. Grants base role permissions.', true)
    RETURNING id INTO internal_group_id;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
      (internal_group_id, 'contacts', true, true, true, true),
      (internal_group_id, 'products', true, true, true, true),
      (internal_group_id, 'sales', true, true, true, true),
      (internal_group_id, 'purchases', true, true, true, true),
      (internal_group_id, 'financials', true, true, true, true),
      (internal_group_id, 'hr', true, true, true, true),
      (internal_group_id, 'leave', true, true, true, true),
      (internal_group_id, 'timesheets', true, true, true, true),
      (internal_group_id, 'projects', true, true, true, true),
      (internal_group_id, 'payroll', true, true, true, true),
      (internal_group_id, 'pos', true, true, true, true),
      (internal_group_id, 'settings', true, true, true, true),
      (internal_group_id, 'team', true, true, true, true);
  END IF;

  -- Payroll Admin
  SELECT id INTO payroll_admin_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Payroll Admin' AND is_system = true;
  IF payroll_admin_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Payroll Admin', 'Full payroll lifecycle: preview, create, approve, post, reverse. Read access to employees and HR.', true)
    RETURNING id INTO payroll_admin_id;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
      (payroll_admin_id, 'payroll', true, true, true, true),
      (payroll_admin_id, 'hr', true, false, false, false),
      (payroll_admin_id, 'leave', true, true, true, false),
      (payroll_admin_id, 'timesheets', true, true, true, false);
  END IF;

  -- Payroll Officer
  SELECT id INTO payroll_officer_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Payroll Officer' AND is_system = true;
  IF payroll_officer_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Payroll Officer', 'Prepare payroll: preview and create draft runs. Cannot approve, post, or reverse.', true)
    RETURNING id INTO payroll_officer_id;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
      (payroll_officer_id, 'payroll', true, true, false, false),
      (payroll_officer_id, 'hr', true, false, false, false);
  END IF;

  -- Accountant
  SELECT id INTO accountant_id
  FROM public.permission_groups
  WHERE organization_id = p_org_id AND name = 'Accountant' AND is_system = true;
  IF accountant_id IS NULL THEN
    INSERT INTO public.permission_groups (organization_id, name, description, is_system)
    VALUES (p_org_id, 'Accountant', 'Financials, sales, purchases, contacts, and read-only payroll for posting to GL.', true)
    RETURNING id INTO accountant_id;
    INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete) VALUES
      (accountant_id, 'financials', true, true, true, true),
      (accountant_id, 'contacts', true, true, true, true),
      (accountant_id, 'sales', true, true, true, true),
      (accountant_id, 'purchases', true, true, true, true),
      (accountant_id, 'payroll', true, false, true, false),
      (accountant_id, 'products', true, true, true, false);
  END IF;
END;
$function$;

-- ============================================================================
-- 4. Backfill: ensure every existing org has the new system groups
-- ============================================================================
DO $$
DECLARE
  org_rec RECORD;
BEGIN
  FOR org_rec IN SELECT id FROM public.organizations LOOP
    PERFORM public.seed_default_permission_groups(org_rec.id);
  END LOOP;
END $$;

-- ============================================================================
-- 5. Repair drifted "Internal User" group rules (BOMA NET AFRICA had hand-edits)
-- ============================================================================
-- For every system-tagged "Internal User" group, ensure all 13 modules have full RCWD.
WITH target_groups AS (
  SELECT id FROM public.permission_groups
  WHERE name = 'Internal User' AND is_system = true
),
target_modules(module) AS (
  VALUES ('contacts'), ('products'), ('sales'), ('purchases'),
         ('financials'), ('hr'), ('leave'), ('timesheets'),
         ('projects'), ('payroll'), ('pos'), ('settings'), ('team')
)
INSERT INTO public.permission_group_rules (permission_group_id, module, can_read, can_create, can_write, can_delete)
SELECT tg.id, tm.module, true, true, true, true
FROM target_groups tg CROSS JOIN target_modules tm
ON CONFLICT (permission_group_id, module) 
DO UPDATE SET can_read = true, can_create = true, can_write = true, can_delete = true;

-- ============================================================================
-- 6. Fix get_user_session_data: return real permission_group_rules per org
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
  org_array jsonb := '[]'::jsonb;
  org_row record;
  plan_data jsonb;
  apps jsonb;
  features jsonb;
  overrides jsonb;
  user_count int;
  storage_used numeric;
  org_entry jsonb;
  is_admin boolean;
  role_row record;
  group_rules jsonb;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = p_user_id AND is_active = true
  ) INTO is_admin;

  FOR org_row IN
    SELECT o.id, o.name, o.slug, o.logo_url, o.base_currency, o.email, o.phone,
           o.address, o.city, o.state, o.postal_code, o.country,
           o.subscription_plan_id, o.subscription_status,
           o.subscription_started_at, o.subscription_ends_at,
           o.trial_ends_at, o.is_suspended, o.suspended_at, o.suspended_reason
    FROM organizations o
    JOIN user_roles ur ON ur.organization_id = o.id
    WHERE ur.user_id = p_user_id AND ur.is_active = true
    ORDER BY o.created_at ASC
  LOOP
    SELECT ur.id AS role_id, ur.role, COALESCE(ur.user_type, 'internal') AS user_type
    INTO role_row
    FROM user_roles ur
    WHERE ur.user_id = p_user_id AND ur.organization_id = org_row.id AND ur.is_active = true
    LIMIT 1;

    SELECT jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'description', p.description,
      'price_monthly', p.price_monthly,
      'price_yearly', p.price_yearly,
      'features', COALESCE(p.features, '[]'::jsonb),
      'max_users', p.max_users,
      'max_invoices_per_month', p.max_invoices_per_month,
      'max_organizations', COALESCE(p.max_organizations, 1),
      'grace_period_days', p.grace_period_days,
      'max_storage_mb', p.max_storage_mb
    ) INTO plan_data
    FROM platform_subscription_plans p
    WHERE p.id = org_row.subscription_plan_id;

    SELECT COALESCE(jsonb_agg(app_id), '[]'::jsonb)
    INTO apps
    FROM plan_app_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('key', feature_key, 'value', limit_value)), '[]'::jsonb)
    INTO features
    FROM plan_feature_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'type', override_type, 'key', key, 'value', override_value, 'expires_at', expires_at
    )), '[]'::jsonb)
    INTO overrides
    FROM org_entitlement_overrides
    WHERE organization_id = org_row.id AND is_active = true
      AND (expires_at IS NULL OR expires_at > now());

    SELECT COUNT(DISTINCT user_id) INTO user_count
    FROM user_roles WHERE organization_id = org_row.id AND is_active = true;

    BEGIN
      SELECT COALESCE(public.get_org_storage_usage_mb(org_row.id), 0) INTO storage_used;
    EXCEPTION WHEN OTHERS THEN
      storage_used := 0;
    END;

    -- Real permission group rules for this user in this org (was '[]'::jsonb)
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'module', pgr.module,
      'can_read', pgr.can_read,
      'can_create', pgr.can_create,
      'can_write', pgr.can_write,
      'can_delete', pgr.can_delete
    )), '[]'::jsonb)
    INTO group_rules
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = p_user_id AND mpg.organization_id = org_row.id;

    org_entry := jsonb_build_object(
      'id', org_row.id,
      'name', org_row.name,
      'slug', org_row.slug,
      'logo_url', org_row.logo_url,
      'base_currency', org_row.base_currency,
      'email', org_row.email,
      'phone', org_row.phone,
      'address', org_row.address,
      'city', org_row.city,
      'state', org_row.state,
      'postal_code', org_row.postal_code,
      'country', org_row.country,
      'subscription_plan_id', org_row.subscription_plan_id,
      'subscription_status', org_row.subscription_status,
      'subscription_started_at', org_row.subscription_started_at,
      'subscription_ends_at', org_row.subscription_ends_at,
      'trial_ends_at', org_row.trial_ends_at,
      'is_suspended', org_row.is_suspended,
      'suspended_at', org_row.suspended_at,
      'suspended_reason', org_row.suspended_reason,
      'role', COALESCE(role_row.role, 'internal'),
      'role_id', role_row.role_id,
      'user_type', COALESCE(role_row.user_type, 'internal'),
      'plan', COALESCE(plan_data, 'null'::jsonb),
      'app_entitlements', apps,
      'entitlements', (SELECT COALESCE(jsonb_agg(f->>'key'), '[]'::jsonb) FROM jsonb_array_elements(features) AS f),
      'feature_limits', (
        SELECT COALESCE(jsonb_object_agg(f->>'key', f->'value'), '{}'::jsonb)
        FROM jsonb_array_elements(features) AS f
        WHERE f->'value' IS NOT NULL AND f->>'value' != 'null'
      ),
      'entitled_features', features,
      'overrides', overrides,
      'limit_overrides', (
        SELECT COALESCE(jsonb_object_agg(ov->>'key', ov->'value'), '{}'::jsonb)
        FROM jsonb_array_elements(overrides) AS ov
        WHERE ov->>'type' = 'limit'
      ),
      'usage_counters', jsonb_build_object(
        'users_count', user_count,
        'invoices_this_month', 0,
        'businesses_count', 0,
        'storage_used_mb', storage_used
      ),
      'permission_group_rules', group_rules
    );

    org_array := org_array || jsonb_build_array(org_entry);
  END LOOP;

  IF jsonb_array_length(org_array) = 0 THEN
    RETURN jsonb_build_object('error', 'no_organization');
  END IF;

  result := jsonb_build_object(
    'organizations', org_array,
    'user_id', p_user_id,
    'is_platform_admin', is_admin,
    'fetched_at', now()
  );

  RETURN result;
END;
$function$;
