
-- ============================================================
-- 1. settings_audit_log table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.settings_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NULL,
  branch_id uuid NULL,
  actor_id uuid NULL,
  setting_scope text NOT NULL,
  setting_key text NOT NULL,
  table_name text NOT NULL,
  record_id uuid NULL,
  old_value jsonb NULL,
  new_value jsonb NULL,
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settings_audit_log_org_created
  ON public.settings_audit_log (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_settings_audit_log_scope_key
  ON public.settings_audit_log (setting_scope, setting_key);

ALTER TABLE public.settings_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can view their audit log"
  ON public.settings_audit_log;
CREATE POLICY "Org members can view their audit log"
  ON public.settings_audit_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
       WHERE user_id = auth.uid()
         AND organization_id = settings_audit_log.organization_id
         AND is_active = true
    )
    OR EXISTS (
      SELECT 1 FROM public.user_roles
       WHERE user_id = auth.uid()
         AND role = 'super_admin'
         AND is_active = true
    )
  );

DROP POLICY IF EXISTS "Platform admins can delete audit log entries"
  ON public.settings_audit_log;
CREATE POLICY "Platform admins can delete audit log entries"
  ON public.settings_audit_log
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
       WHERE user_id = auth.uid()
         AND role = 'super_admin'
         AND is_active = true
    )
  );

-- Inserts come exclusively from triggers (SECURITY DEFINER), so no insert policy needed.

-- ============================================================
-- 2. Generic settings audit trigger function
-- ============================================================
-- Each table that opts in declares its scope + watched columns via TG_ARGV.
-- Usage:
--   CREATE TRIGGER audit_xxx AFTER UPDATE ON public.xxx
--     FOR EACH ROW EXECUTE FUNCTION public.audit_settings_change(
--       'business',                    -- scope
--       'name,tax_id,base_currency'    -- comma-separated watched columns
--     );

CREATE OR REPLACE FUNCTION public.audit_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_scope text := COALESCE(TG_ARGV[0], 'unknown');
  v_watched text := COALESCE(TG_ARGV[1], '');
  v_org_id uuid;
  v_business_id uuid;
  v_branch_id uuid;
  v_record_id uuid;
  v_changes_old jsonb := '{}'::jsonb;
  v_changes_new jsonb := '{}'::jsonb;
  v_old jsonb;
  v_new jsonb;
  v_col text;
  v_changed boolean := false;
BEGIN
  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);

  -- Pull scope identifiers if present.
  v_org_id     := NULLIF(v_new->>'organization_id','')::uuid;
  v_business_id := NULLIF(v_new->>'business_id','')::uuid;
  v_branch_id  := NULLIF(v_new->>'branch_id','')::uuid;
  v_record_id  := NULLIF(v_new->>'id','')::uuid;

  -- Compare each watched column.
  IF v_watched <> '' THEN
    FOR v_col IN SELECT trim(unnest(string_to_array(v_watched, ','))) LOOP
      IF (v_old ? v_col) AND (v_new ? v_col)
         AND (v_old->v_col) IS DISTINCT FROM (v_new->v_col) THEN
        v_changes_old := v_changes_old || jsonb_build_object(v_col, v_old->v_col);
        v_changes_new := v_changes_new || jsonb_build_object(v_col, v_new->v_col);
        v_changed := true;
      END IF;
    END LOOP;
  END IF;

  IF NOT v_changed THEN
    RETURN NEW;
  END IF;

  -- If we still don't have an org_id, try to derive from business or branch.
  IF v_org_id IS NULL AND v_business_id IS NOT NULL THEN
    SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = v_business_id;
  END IF;
  IF v_org_id IS NULL AND v_branch_id IS NOT NULL THEN
    SELECT organization_id INTO v_org_id FROM public.branches WHERE id = v_branch_id;
  END IF;

  IF v_org_id IS NULL THEN
    -- Cannot scope the audit row safely; skip.
    RETURN NEW;
  END IF;

  INSERT INTO public.settings_audit_log (
    organization_id, business_id, branch_id, actor_id,
    setting_scope, setting_key, table_name, record_id,
    old_value, new_value
  ) VALUES (
    v_org_id, v_business_id, v_branch_id, auth.uid(),
    v_scope,
    array_to_string(ARRAY(SELECT jsonb_object_keys(v_changes_new)), ','),
    TG_TABLE_NAME,
    v_record_id,
    v_changes_old,
    v_changes_new
  );

  RETURN NEW;
END;
$$;

-- ============================================================
-- 3. Attach audit triggers to sensitive settings tables
-- ============================================================
-- We attach to UPDATE only (creation is itself an audit event captured by created_at).

-- businesses (legal identity / branding / books)
DROP TRIGGER IF EXISTS audit_businesses_settings ON public.businesses;
CREATE TRIGGER audit_businesses_settings
  AFTER UPDATE ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_settings_change(
    'business',
    'name,legal_name,tax_id,registration_number,address,phone,email,base_currency,fiscal_year_start,timezone,logo_url,invoice_prefix,receipt_header,receipt_footer'
  );

-- branches
DROP TRIGGER IF EXISTS audit_branches_settings ON public.branches;
CREATE TRIGGER audit_branches_settings
  AFTER UPDATE ON public.branches
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_settings_change(
    'branch',
    'name,code,address,phone,email,is_active'
  );

-- branch_setting_overrides
DROP TRIGGER IF EXISTS audit_branch_setting_overrides ON public.branch_setting_overrides;
CREATE TRIGGER audit_branch_setting_overrides
  AFTER UPDATE ON public.branch_setting_overrides
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_settings_change(
    'branch',
    'value'
  );

-- tax_rates
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='tax_rates') THEN
    DROP TRIGGER IF EXISTS audit_tax_rates_settings ON public.tax_rates;
    CREATE TRIGGER audit_tax_rates_settings
      AFTER UPDATE ON public.tax_rates
      FOR EACH ROW
      EXECUTE FUNCTION public.audit_settings_change(
        'tax',
        'name,rate,is_active,is_default,tax_type'
      );
  END IF;
END$$;

-- payment_provider_configs
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='payment_provider_configs') THEN
    DROP TRIGGER IF EXISTS audit_payment_provider_configs ON public.payment_provider_configs;
    CREATE TRIGGER audit_payment_provider_configs
      AFTER UPDATE ON public.payment_provider_configs
      FOR EACH ROW
      EXECUTE FUNCTION public.audit_settings_change(
        'payments',
        'is_active,provider,environment,config'
      );
  END IF;
END$$;

-- default_account_settings
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='default_account_settings') THEN
    DROP TRIGGER IF EXISTS audit_default_account_settings ON public.default_account_settings;
    CREATE TRIGGER audit_default_account_settings
      AFTER UPDATE ON public.default_account_settings
      FOR EACH ROW
      EXECUTE FUNCTION public.audit_settings_change(
        'accounting',
        'sales_account_id,purchase_account_id,tax_payable_account_id,bank_account_id,cash_account_id,retained_earnings_account_id'
      );
  END IF;
END$$;

-- notification_alert_settings
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='notification_alert_settings') THEN
    DROP TRIGGER IF EXISTS audit_notification_alert_settings ON public.notification_alert_settings;
    CREATE TRIGGER audit_notification_alert_settings
      AFTER UPDATE ON public.notification_alert_settings
      FOR EACH ROW
      EXECUTE FUNCTION public.audit_settings_change(
        'notifications',
        'is_enabled,channel,settings'
      );
  END IF;
END$$;

-- pos_settings
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='pos_settings') THEN
    DROP TRIGGER IF EXISTS audit_pos_settings ON public.pos_settings;
    CREATE TRIGGER audit_pos_settings
      AFTER UPDATE ON public.pos_settings
      FOR EACH ROW
      EXECUTE FUNCTION public.audit_settings_change(
        'pos',
        'receipt_header,receipt_footer,default_tax_rate,allow_discount,require_customer'
      );
  END IF;
END$$;

-- ============================================================
-- 4. compute_org_billing_for_plan — preview-mode billing math
-- ============================================================
CREATE OR REPLACE FUNCTION public.compute_org_billing_for_plan(
  p_org_id uuid,
  p_plan_id uuid,
  p_billing_cycle text DEFAULT 'monthly'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_plan RECORD;
  v_currency text;
  v_plan_price numeric := 0;
  v_user_count int := 0;
  v_addons jsonb := '[]'::jsonb;
  v_addons_total numeric := 0;
  v_total numeric := 0;
  v_cycle text := lower(coalesce(p_billing_cycle, 'monthly'));
BEGIN
  IF p_org_id IS NULL OR p_plan_id IS NULL THEN
    RETURN jsonb_build_object('error', 'org_id_and_plan_id_required');
  END IF;

  IF v_cycle NOT IN ('monthly', 'yearly') THEN
    v_cycle := 'monthly';
  END IF;

  -- Authorization: caller must belong to the org (or be platform super_admin).
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND organization_id = p_org_id
       AND is_active = true
  ) AND NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND role = 'super_admin'
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a member of organization %', p_org_id
      USING ERRCODE = '42501';
  END IF;

  -- Load the candidate plan.
  SELECT psp.id, psp.name, psp.price_monthly, psp.price_yearly,
         psp.price_per_user_monthly, psp.price_per_user_yearly,
         coalesce(psp.currency, psp.base_currency, 'USD') AS currency
    INTO v_plan
    FROM public.platform_subscription_plans psp
   WHERE psp.id = p_plan_id;

  IF v_plan.id IS NULL THEN
    RETURN jsonb_build_object('error', 'plan_not_found');
  END IF;

  v_currency := v_plan.currency;
  v_plan_price := CASE WHEN v_cycle = 'yearly'
                       THEN coalesce(v_plan.price_yearly, 0)
                       ELSE coalesce(v_plan.price_monthly, 0) END;

  IF (v_cycle = 'monthly' AND coalesce(v_plan.price_per_user_monthly, 0) > 0)
     OR (v_cycle = 'yearly' AND coalesce(v_plan.price_per_user_yearly, 0) > 0) THEN
    SELECT COUNT(DISTINCT user_id) INTO v_user_count
      FROM public.user_roles
     WHERE organization_id = p_org_id AND is_active = true;
    v_plan_price := v_plan_price + (v_user_count * CASE WHEN v_cycle = 'yearly'
                                                        THEN coalesce(v_plan.price_per_user_yearly, 0)
                                                        ELSE coalesce(v_plan.price_per_user_monthly, 0) END);
  END IF;

  WITH installed AS (
    SELECT oia.app_id
      FROM public.organization_installed_apps oia
     WHERE oia.organization_id = p_org_id
       AND coalesce(oia.is_active, true) = true
  ),
  in_plan AS (
    SELECT app_id FROM public.plan_app_access
     WHERE plan_id = v_plan.id AND is_enabled = true
  ),
  on_trial AS (
    SELECT app_id FROM public.app_trial_status
     WHERE organization_id = p_org_id
       AND status = 'active'
       AND expires_at > now()
  ),
  billable AS (
    SELECT i.app_id
      FROM installed i
     WHERE NOT EXISTS (SELECT 1 FROM in_plan p WHERE p.app_id = i.app_id)
       AND NOT EXISTS (SELECT 1 FROM on_trial t WHERE t.app_id = i.app_id)
  ),
  priced AS (
    SELECT b.app_id,
           coalesce(apr.monthly_price, 0) AS monthly_price,
           coalesce(apr.yearly_price, 0)  AS yearly_price,
           coalesce(apr.is_per_user, false) AS is_per_user,
           CASE WHEN v_cycle = 'yearly' THEN coalesce(apr.yearly_price, 0)
                ELSE coalesce(apr.monthly_price, 0) END
             * CASE WHEN coalesce(apr.is_per_user, false)
                    THEN GREATEST(1, (SELECT COUNT(DISTINCT user_id)::int
                                        FROM public.user_roles
                                       WHERE organization_id = p_org_id
                                         AND is_active = true))
                    ELSE 1 END AS line_total
      FROM billable b
      LEFT JOIN public.app_pricing_rules apr
             ON apr.app_id = b.app_id
            AND coalesce(apr.is_active, true) = true
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
            'app_id', app_id,
            'monthly_price', monthly_price,
            'yearly_price', yearly_price,
            'is_per_user', is_per_user,
            'line_total', line_total
         )), '[]'::jsonb),
         coalesce(sum(line_total), 0)
    INTO v_addons, v_addons_total
    FROM priced;

  v_total := v_plan_price + v_addons_total;

  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'plan_id', v_plan.id,
    'plan_name', v_plan.name,
    'billing_cycle', v_cycle,
    'currency', v_currency,
    'user_count', v_user_count,
    'plan_price', v_plan_price,
    'addons', v_addons,
    'addons_total', v_addons_total,
    'total', v_total,
    'preview', true,
    'computed_at', now()
  );
END;
$$;
