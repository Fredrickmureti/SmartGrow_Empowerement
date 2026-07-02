
-- ============================================================
-- 1. NEW TABLE: org_entitlement_overrides
-- ============================================================
CREATE TABLE public.org_entitlement_overrides (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  override_type TEXT NOT NULL CHECK (override_type IN ('feature', 'app', 'limit')),
  key TEXT NOT NULL,
  override_value JSONB NOT NULL DEFAULT 'true'::jsonb,
  reason TEXT,
  granted_by UUID REFERENCES auth.users(id),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_org_overrides_org_active ON public.org_entitlement_overrides(organization_id, is_active);
CREATE INDEX idx_org_overrides_type_key ON public.org_entitlement_overrides(override_type, key);
CREATE UNIQUE INDEX idx_org_overrides_unique ON public.org_entitlement_overrides(organization_id, override_type, key) WHERE is_active = true;

ALTER TABLE public.org_entitlement_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can manage overrides"
  ON public.org_entitlement_overrides
  FOR ALL
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

-- ============================================================
-- 2. NEW TABLE: org_usage_counters
-- ============================================================
CREATE TABLE public.org_usage_counters (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL,
  current_value INTEGER NOT NULL DEFAULT 0,
  period_start DATE NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::date,
  period_end DATE NOT NULL DEFAULT (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')::date,
  hard_limit INTEGER,
  soft_limit INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_usage_counters_org_metric_period ON public.org_usage_counters(organization_id, metric_key, period_start);

ALTER TABLE public.org_usage_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can manage usage counters"
  ON public.org_usage_counters FOR ALL
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE POLICY "Org members can view own counters"
  ON public.org_usage_counters FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
      AND ur.organization_id = org_usage_counters.organization_id
      AND ur.is_active = true
    )
  );

-- ============================================================
-- 3. ENHANCE platform_subscription_plans
-- ============================================================
ALTER TABLE public.platform_subscription_plans
  ADD COLUMN IF NOT EXISTS grace_period_days INTEGER DEFAULT 7,
  ADD COLUMN IF NOT EXISTS max_storage_mb INTEGER;

-- ============================================================
-- 4. ENHANCED FUNCTION: check_org_feature_access_v2
-- Checks overrides first, then plan defaults
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_org_feature_access_v2(_org_id UUID, _feature_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    -- Check active override first (not expired)
    WHEN EXISTS (
      SELECT 1 FROM org_entitlement_overrides
      WHERE organization_id = _org_id
        AND override_type = 'feature'
        AND key = _feature_key
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > NOW())
    ) THEN
      (SELECT (override_value)::text::boolean
       FROM org_entitlement_overrides
       WHERE organization_id = _org_id
         AND override_type = 'feature'
         AND key = _feature_key
         AND is_active = true
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1)
    -- Fall back to plan
    ELSE
      COALESCE(
        (SELECT pfa.is_enabled
         FROM organizations o
         JOIN plan_feature_access pfa ON pfa.plan_id = o.subscription_plan_id
         WHERE o.id = _org_id AND pfa.feature_key = _feature_key),
        false
      )
  END
$$;

-- ============================================================
-- 5. HELPER: get effective user limit for an org
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_effective_user_limit(_org_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    -- Override takes priority
    (SELECT (override_value->>'value')::integer
     FROM org_entitlement_overrides
     WHERE organization_id = _org_id
       AND override_type = 'limit'
       AND key = 'max_users'
       AND is_active = true
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1),
    -- Plan default
    (SELECT psp.max_users
     FROM organizations o
     JOIN platform_subscription_plans psp ON psp.id = o.subscription_plan_id
     WHERE o.id = _org_id),
    -- No limit if nothing configured
    NULL
  )
$$;

-- ============================================================
-- 6. HELPER: get effective invoice limit
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_effective_invoice_limit(_org_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT (override_value->>'value')::integer
     FROM org_entitlement_overrides
     WHERE organization_id = _org_id
       AND override_type = 'limit'
       AND key = 'max_invoices_per_month'
       AND is_active = true
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1),
    (SELECT psp.max_invoices_per_month
     FROM organizations o
     JOIN platform_subscription_plans psp ON psp.id = o.subscription_plan_id
     WHERE o.id = _org_id),
    NULL
  )
$$;

-- ============================================================
-- 7. TRIGGER: enforce user count limit on user_roles INSERT
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_user_count_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
  v_current_count INTEGER;
BEGIN
  -- Skip enforcement during org creation (owner role) 
  -- by checking if org already has any active roles
  SELECT COUNT(*) INTO v_current_count
  FROM user_roles
  WHERE organization_id = NEW.organization_id
  AND is_active = true;

  -- If this is the first user (org creation), always allow
  IF v_current_count = 0 THEN
    RETURN NEW;
  END IF;

  v_limit := get_effective_user_limit(NEW.organization_id);

  -- NULL limit means unlimited
  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  -- Count distinct users (not roles) to handle multi-role users
  SELECT COUNT(DISTINCT user_id) INTO v_current_count
  FROM user_roles
  WHERE organization_id = NEW.organization_id
  AND is_active = true;

  -- If the user already has a role in this org, allow (just adding another role)
  IF EXISTS (
    SELECT 1 FROM user_roles
    WHERE organization_id = NEW.organization_id
    AND user_id = NEW.user_id
    AND is_active = true
  ) THEN
    RETURN NEW;
  END IF;

  IF v_current_count >= v_limit THEN
    RAISE EXCEPTION 'User limit reached. Your plan allows % users. Please upgrade or contact support.', v_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_user_count ON public.user_roles;
CREATE TRIGGER trg_enforce_user_count
  BEFORE INSERT ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_user_count_limit();

-- ============================================================
-- 8. TRIGGER: enforce invoice count limit on invoices INSERT
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_invoice_count_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
  v_current_count INTEGER;
  v_period_start DATE;
BEGIN
  v_limit := get_effective_invoice_limit(NEW.organization_id);

  -- NULL limit means unlimited
  IF v_limit IS NULL THEN
    RETURN NEW;
  END IF;

  v_period_start := date_trunc('month', CURRENT_DATE)::date;

  SELECT COUNT(*) INTO v_current_count
  FROM invoices
  WHERE organization_id = NEW.organization_id
  AND created_at >= v_period_start;

  IF v_current_count >= v_limit THEN
    RAISE EXCEPTION 'Monthly invoice limit reached (% of % allowed). Please upgrade or contact support.', v_current_count, v_limit
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_invoice_count ON public.invoices;
CREATE TRIGGER trg_enforce_invoice_count
  BEFORE INSERT ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_invoice_count_limit();

-- ============================================================
-- 9. RLS: Add subscription-active checks to INSERT on key tables
-- Uses rls_check_org_subscription_active which already exists
-- Allows NULL subscription_status for backward compat
-- ============================================================

-- Helper that's safe for RLS (allows NULL status = no plan assigned yet)
CREATE OR REPLACE FUNCTION public.rls_check_org_can_write(_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN o.subscription_status IS NULL THEN true  -- No subscription configured, allow
    WHEN o.is_suspended = true THEN false
    WHEN o.subscription_status = 'active' AND (o.subscription_ends_at IS NULL OR o.subscription_ends_at > NOW()) THEN true
    WHEN o.subscription_status = 'trial' AND (o.trial_ends_at IS NULL OR o.trial_ends_at > NOW()) THEN true
    ELSE false
  END
  FROM organizations o
  WHERE o.id = _org_id
$$;

-- Add subscription check to INSERT policies on key business tables
-- We create permissive policies that stack with existing org-membership policies

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoices', 'bills', 'journal_entries', 'expenses', 'products', 'contacts'] LOOP
    EXECUTE format(
      'CREATE POLICY "Subscription active check for insert on %I" ON public.%I FOR INSERT WITH CHECK (public.rls_check_org_can_write(organization_id))',
      t, t
    );
  END LOOP;
END $$;

-- ============================================================
-- 10. ENHANCE get_user_session_data to include overrides
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_session_data(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_org_data JSONB;
  v_first_org_id UUID;
  v_trial_all_apps BOOLEAN;
  v_all_app_ids TEXT[];
BEGIN
  -- Get trial_all_apps_access setting from platform_settings
  SELECT COALESCE(
    (SELECT setting_value::boolean 
     FROM platform_settings 
     WHERE setting_key = 'trial_all_apps_access'),
    true
  ) INTO v_trial_all_apps;

  -- Get all unique app IDs from plan_app_access (for trial mode)
  SELECT ARRAY(
    SELECT DISTINCT app_id 
    FROM plan_app_access
  ) INTO v_all_app_ids;

  IF v_all_app_ids IS NULL OR array_length(v_all_app_ids, 1) IS NULL THEN
    v_all_app_ids := ARRAY['finance','sales','purchases','inventory','pos','crm','hr','projects','reports','documents','sign','spreadsheets','platform'];
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'id', o.id,
      'name', o.name,
      'slug', o.slug,
      'logo_url', o.logo_url,
      'base_currency', o.base_currency,
      'email', o.email,
      'phone', o.phone,
      'address', o.address,
      'city', o.city,
      'state', o.state,
      'postal_code', o.postal_code,
      'country', o.country,
      'subscription_plan_id', o.subscription_plan_id,
      'subscription_status', o.subscription_status,
      'subscription_started_at', o.subscription_started_at,
      'subscription_ends_at', o.subscription_ends_at,
      'trial_ends_at', o.trial_ends_at,
      'is_suspended', o.is_suspended,
      'suspended_at', o.suspended_at,
      'suspended_reason', o.suspended_reason,
      'role', ur.role,
      'role_id', ur.id,
      'user_type', ur.user_type,
      'computed_status', jsonb_build_object(
        'is_active', CASE
          WHEN o.is_suspended = true THEN false
          WHEN o.subscription_status = 'active' AND (o.subscription_ends_at IS NULL OR o.subscription_ends_at > NOW()) THEN true
          WHEN o.subscription_status = 'trial' AND (o.trial_ends_at IS NULL OR o.trial_ends_at > NOW()) THEN true
          ELSE false
        END,
        'is_suspended', COALESCE(o.is_suspended, false),
        'is_trialing', o.subscription_status = 'trial' AND (o.trial_ends_at IS NULL OR o.trial_ends_at > NOW()),
        'is_expired', CASE
          WHEN o.is_suspended = true THEN false
          WHEN o.subscription_status IN ('expired', 'cancelled') THEN true
          WHEN o.subscription_status = 'trial' AND o.trial_ends_at IS NOT NULL AND o.trial_ends_at <= NOW() THEN true
          WHEN o.subscription_status = 'active' AND o.subscription_ends_at IS NOT NULL AND o.subscription_ends_at <= NOW() THEN true
          ELSE false
        END,
        'days_remaining', CASE
          WHEN o.subscription_status = 'trial' AND o.trial_ends_at IS NOT NULL 
            THEN GREATEST(0, EXTRACT(DAY FROM o.trial_ends_at - NOW())::integer)
          WHEN o.subscription_status = 'active' AND o.subscription_ends_at IS NOT NULL 
            THEN GREATEST(0, EXTRACT(DAY FROM o.subscription_ends_at - NOW())::integer)
          ELSE NULL
        END
      ),
      'plan', (
        SELECT jsonb_build_object(
          'id', psp.id,
          'name', psp.name,
          'description', psp.description,
          'price_monthly', psp.price_monthly,
          'price_yearly', psp.price_yearly,
          'features', psp.features,
          'max_users', psp.max_users,
          'max_invoices_per_month', psp.max_invoices_per_month,
          'max_organizations', psp.max_organizations,
          'grace_period_days', psp.grace_period_days,
          'max_storage_mb', psp.max_storage_mb
        )
        FROM platform_subscription_plans psp
        WHERE psp.id = o.subscription_plan_id
      ),
      -- Entitlements: plan features + feature overrides (grant)
      'entitlements', (
        SELECT COALESCE(jsonb_agg(DISTINCT feat), '[]'::jsonb)
        FROM (
          -- Plan features
          SELECT pfa.feature_key AS feat
          FROM plan_feature_access pfa
          WHERE pfa.plan_id = o.subscription_plan_id AND pfa.is_enabled = true
          UNION
          -- Override grants (feature type, active, not expired, value = true)
          SELECT oeo.key AS feat
          FROM org_entitlement_overrides oeo
          WHERE oeo.organization_id = o.id
            AND oeo.override_type = 'feature'
            AND oeo.is_active = true
            AND (oeo.expires_at IS NULL OR oeo.expires_at > NOW())
            AND (oeo.override_value)::text::boolean = true
        ) sub
      ),
      'feature_limits', (
        SELECT COALESCE(
          jsonb_object_agg(pfa.feature_key, pfa.limit_value),
          '{}'::jsonb
        )
        FROM plan_feature_access pfa
        WHERE pfa.plan_id = o.subscription_plan_id
        AND pfa.limit_value IS NOT NULL
      ),
      -- App entitlements: plan apps + app overrides
      'app_entitlements', (
        CASE 
          WHEN o.subscription_status = 'trial' 
               AND (o.trial_ends_at IS NULL OR o.trial_ends_at > NOW())
               AND v_trial_all_apps = true
          THEN to_jsonb(v_all_app_ids)
          ELSE (
            SELECT COALESCE(jsonb_agg(DISTINCT app), '[]'::jsonb)
            FROM (
              -- Plan apps
              SELECT paa.app_id AS app
              FROM plan_app_access paa
              WHERE paa.plan_id = o.subscription_plan_id AND paa.is_enabled = true
              UNION
              -- Override app grants
              SELECT oeo.key AS app
              FROM org_entitlement_overrides oeo
              WHERE oeo.organization_id = o.id
                AND oeo.override_type = 'app'
                AND oeo.is_active = true
                AND (oeo.expires_at IS NULL OR oeo.expires_at > NOW())
                AND (oeo.override_value)::text::boolean = true
            ) sub
          )
        END
      ),
      -- Limit overrides for frontend display
      'limit_overrides', (
        SELECT COALESCE(
          jsonb_object_agg(oeo.key, oeo.override_value),
          '{}'::jsonb
        )
        FROM org_entitlement_overrides oeo
        WHERE oeo.organization_id = o.id
          AND oeo.override_type = 'limit'
          AND oeo.is_active = true
          AND (oeo.expires_at IS NULL OR oeo.expires_at > NOW())
      ),
      -- Permission group rules
      'permission_group_rules', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'module', pgr.module,
            'can_read', pgr.can_read,
            'can_create', pgr.can_create,
            'can_write', pgr.can_write,
            'can_delete', pgr.can_delete
          )
        ), '[]'::jsonb)
        FROM member_permission_groups mpg
        JOIN permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
        WHERE mpg.user_id = p_user_id
          AND mpg.organization_id = o.id
      )
    )
  )
  INTO v_org_data
  FROM user_roles ur
  JOIN organizations o ON o.id = ur.organization_id
  WHERE ur.user_id = p_user_id
  AND ur.is_active = true;

  v_first_org_id := (v_org_data->0->>'id')::UUID;

  v_result := jsonb_build_object(
    'organizations', COALESCE(v_org_data, '[]'::jsonb),
    'user_id', p_user_id,
    'is_platform_admin', public.is_platform_admin(p_user_id),
    'fetched_at', NOW()
  );

  RETURN v_result;
END;
$$;
