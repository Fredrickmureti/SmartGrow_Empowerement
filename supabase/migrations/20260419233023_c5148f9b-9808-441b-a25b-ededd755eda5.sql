-- ============================================================================
-- PHASE B: SCHEMA HARDENING — MULTI-ENTITY CORRECTNESS
-- DB has 0 rows of business data, so backfill is a no-op for almost everything.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ADD business_id COLUMNS TO TABLES THAT LACK THEM
-- ----------------------------------------------------------------------------
ALTER TABLE public.depreciation_entries     ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;
ALTER TABLE public.asset_categories         ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;
ALTER TABLE public.asset_maintenance        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;
ALTER TABLE public.analytic_accounts        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;
ALTER TABLE public.analytic_distributions   ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;
ALTER TABLE public.analytic_groups          ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;
ALTER TABLE public.salary_structures        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;
ALTER TABLE public.employee_benefits        ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;
ALTER TABLE public.budget_actuals           ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE RESTRICT;

-- ----------------------------------------------------------------------------
-- 2. BACKFILL business_id FROM PARENT RECORDS WHERE POSSIBLE,
--    OTHERWISE FROM THE ORG'S FIRST (PRIMARY) ACTIVE COMPANY
-- ----------------------------------------------------------------------------

-- Helper CTE pattern: pick the org's oldest active business as a default.
-- Used for tables that have no parent FK to derive business_id from.
WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses
  WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.payments p
SET business_id = COALESCE(
  (SELECT i.business_id FROM public.invoices i WHERE i.id = p.invoice_id),
  (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = p.organization_id)
)
WHERE p.business_id IS NULL;

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.bill_payments bp
SET business_id = COALESCE(
  (SELECT b.business_id FROM public.bills b WHERE b.id = bp.bill_id),
  (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = bp.organization_id)
)
WHERE bp.business_id IS NULL;

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.expenses e
SET business_id = (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = e.organization_id)
WHERE e.business_id IS NULL;

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.expense_categories ec
SET business_id = (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = ec.organization_id)
WHERE ec.business_id IS NULL;

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.payroll_periods pp
SET business_id = (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = pp.organization_id)
WHERE pp.business_id IS NULL;

-- Tables that newly got business_id: backfill from parent or primary biz
WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.depreciation_entries de
SET business_id = COALESCE(
  (SELECT fa.business_id FROM public.fixed_assets fa WHERE fa.id = de.asset_id),
  (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = de.organization_id)
);

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.asset_categories ac
SET business_id = (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = ac.organization_id);

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.asset_maintenance am
SET business_id = COALESCE(
  (SELECT fa.business_id FROM public.fixed_assets fa WHERE fa.id = am.asset_id),
  (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = am.organization_id)
);

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.analytic_accounts aa
SET business_id = (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = aa.organization_id);

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.analytic_distributions ad
SET business_id = COALESCE(
  (SELECT a.business_id FROM public.analytic_accounts a WHERE a.id = ad.analytic_account_id),
  (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = ad.organization_id)
);

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.analytic_groups ag
SET business_id = (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = ag.organization_id);

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.salary_structures ss
SET business_id = (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = ss.organization_id);

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.employee_benefits eb
SET business_id = (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = eb.organization_id);

WITH primary_biz AS (
  SELECT DISTINCT ON (organization_id) organization_id, id AS business_id
  FROM public.businesses WHERE is_active = true
  ORDER BY organization_id, created_at ASC
)
UPDATE public.budget_actuals ba
SET business_id = (SELECT pb.business_id FROM primary_biz pb WHERE pb.organization_id = ba.organization_id);

-- ----------------------------------------------------------------------------
-- 3. SET business_id NOT NULL ON ALL AT-RISK TABLES
-- ----------------------------------------------------------------------------
-- Only enforce NOT NULL if every row has a value (will succeed if backfill worked
-- or if the table is empty, which is the current case).
DO $$
DECLARE
  t text;
  null_count int;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'payments','bill_payments','expenses','expense_categories','payroll_periods',
    'depreciation_entries','asset_categories','asset_maintenance',
    'analytic_accounts','analytic_distributions','analytic_groups',
    'salary_structures','employee_benefits','budget_actuals'
  ]
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I WHERE business_id IS NULL', t) INTO null_count;
    IF null_count = 0 THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN business_id SET NOT NULL', t);
    ELSE
      RAISE NOTICE 'Skipping NOT NULL on %: % rows still have NULL business_id', t, null_count;
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 4. CROSS-ENTITY CONSISTENCY TRIGGERS
--    A payment's business must equal its invoice's business, etc.
-- ----------------------------------------------------------------------------

-- Payment ↔ Invoice
CREATE OR REPLACE FUNCTION public.enforce_payment_invoice_business_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv_business uuid;
BEGIN
  IF NEW.invoice_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id INTO inv_business FROM public.invoices WHERE id = NEW.invoice_id;
  IF inv_business IS NOT NULL AND NEW.business_id IS NOT NULL AND inv_business <> NEW.business_id THEN
    RAISE EXCEPTION 'Payment business_id (%) must match invoice business_id (%)', NEW.business_id, inv_business
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payment_invoice_business_match ON public.payments;
CREATE TRIGGER trg_payment_invoice_business_match
BEFORE INSERT OR UPDATE OF business_id, invoice_id ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_invoice_business_match();

-- BillPayment ↔ Bill
CREATE OR REPLACE FUNCTION public.enforce_bill_payment_business_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bill_business uuid;
BEGIN
  IF NEW.bill_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id INTO bill_business FROM public.bills WHERE id = NEW.bill_id;
  IF bill_business IS NOT NULL AND NEW.business_id IS NOT NULL AND bill_business <> NEW.business_id THEN
    RAISE EXCEPTION 'Bill payment business_id (%) must match bill business_id (%)', NEW.business_id, bill_business
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bill_payment_business_match ON public.bill_payments;
CREATE TRIGGER trg_bill_payment_business_match
BEFORE INSERT OR UPDATE OF business_id, bill_id ON public.bill_payments
FOR EACH ROW EXECUTE FUNCTION public.enforce_bill_payment_business_match();

-- DepreciationEntry ↔ FixedAsset
CREATE OR REPLACE FUNCTION public.enforce_depreciation_business_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  asset_business uuid;
BEGIN
  IF NEW.asset_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id INTO asset_business FROM public.fixed_assets WHERE id = NEW.asset_id;
  IF asset_business IS NOT NULL AND NEW.business_id IS NOT NULL AND asset_business <> NEW.business_id THEN
    RAISE EXCEPTION 'Depreciation entry business_id (%) must match fixed asset business_id (%)', NEW.business_id, asset_business
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_depreciation_business_match ON public.depreciation_entries;
CREATE TRIGGER trg_depreciation_business_match
BEFORE INSERT OR UPDATE OF business_id, asset_id ON public.depreciation_entries
FOR EACH ROW EXECUTE FUNCTION public.enforce_depreciation_business_match();

-- AssetMaintenance ↔ FixedAsset
CREATE OR REPLACE FUNCTION public.enforce_asset_maintenance_business_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  asset_business uuid;
BEGIN
  IF NEW.asset_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id INTO asset_business FROM public.fixed_assets WHERE id = NEW.asset_id;
  IF asset_business IS NOT NULL AND NEW.business_id IS NOT NULL AND asset_business <> NEW.business_id THEN
    RAISE EXCEPTION 'Asset maintenance business_id (%) must match fixed asset business_id (%)', NEW.business_id, asset_business
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_asset_maintenance_business_match ON public.asset_maintenance;
CREATE TRIGGER trg_asset_maintenance_business_match
BEFORE INSERT OR UPDATE OF business_id, asset_id ON public.asset_maintenance
FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_maintenance_business_match();

-- AnalyticDistribution ↔ AnalyticAccount
CREATE OR REPLACE FUNCTION public.enforce_analytic_distribution_business_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  acct_business uuid;
BEGIN
  IF NEW.analytic_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id INTO acct_business FROM public.analytic_accounts WHERE id = NEW.analytic_account_id;
  IF acct_business IS NOT NULL AND NEW.business_id IS NOT NULL AND acct_business <> NEW.business_id THEN
    RAISE EXCEPTION 'Analytic distribution business_id (%) must match analytic account business_id (%)', NEW.business_id, acct_business
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_analytic_distribution_business_match ON public.analytic_distributions;
CREATE TRIGGER trg_analytic_distribution_business_match
BEFORE INSERT OR UPDATE OF business_id, analytic_account_id ON public.analytic_distributions
FOR EACH ROW EXECUTE FUNCTION public.enforce_analytic_distribution_business_match();

-- ----------------------------------------------------------------------------
-- 5. EXACTLY ONE HEADQUARTERS PER BUSINESS
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS branches_one_hq_per_business
ON public.branches(business_id)
WHERE is_headquarters = true;

-- ----------------------------------------------------------------------------
-- 6. DROP DUPLICATE TRIGGERS (keep the SECURITY DEFINER / better-message variant)
-- ----------------------------------------------------------------------------
-- branches: keep enforce_branch_org_consistency, drop assert_branch_org_matches_business duplicate
DROP TRIGGER IF EXISTS trg_branch_org_consistency ON public.branches;
-- journal_entries: keep enforce_je_business_org_match, drop assert_je_business_belongs_to_org duplicate
DROP TRIGGER IF EXISTS trg_je_business_in_org ON public.journal_entries;
-- businesses: keep lock_business_currency_after_je, drop enforce_business_currency_immutable duplicate
DROP TRIGGER IF EXISTS trg_business_currency_immutable ON public.businesses;

-- ----------------------------------------------------------------------------
-- 7. SLIM get_user_session_data — STOP RETURNING IDENTITY FIELDS ON ORG
--    Identity (currency/address/email/etc.) lives on businesses, not orgs.
--    The frontend now reads those exclusively from BusinessContext / useDocumentBranding.
-- ----------------------------------------------------------------------------
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
    SELECT
      o.id, o.name, o.slug, o.logo_url,
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
      'id', p.id, 'name', p.name, 'description', p.description,
      'price_monthly', p.price_monthly, 'price_yearly', p.price_yearly,
      'features', COALESCE(p.features, '[]'::jsonb),
      'max_users', p.max_users, 'max_invoices_per_month', p.max_invoices_per_month,
      'max_organizations', COALESCE(p.max_organizations, 1),
      'grace_period_days', p.grace_period_days, 'max_storage_mb', p.max_storage_mb
    ) INTO plan_data
    FROM platform_subscription_plans p
    WHERE p.id = org_row.subscription_plan_id;

    SELECT COALESCE(jsonb_agg(app_id), '[]'::jsonb) INTO apps
    FROM plan_app_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('key', feature_key, 'value', limit_value)), '[]'::jsonb)
    INTO features
    FROM plan_feature_access
    WHERE plan_id = org_row.subscription_plan_id AND is_enabled = true;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'type', override_type, 'key', key, 'value', override_value, 'expires_at', expires_at
    )), '[]'::jsonb) INTO overrides
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

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'module', pgr.module, 'can_read', pgr.can_read, 'can_create', pgr.can_create,
      'can_write', pgr.can_write, 'can_delete', pgr.can_delete
    )), '[]'::jsonb) INTO group_rules
    FROM public.member_permission_groups mpg
    JOIN public.permission_group_rules pgr ON pgr.permission_group_id = mpg.permission_group_id
    WHERE mpg.user_id = p_user_id AND mpg.organization_id = org_row.id;

    org_entry := jsonb_build_object(
      'id', org_row.id, 'name', org_row.name, 'slug', org_row.slug,
      'logo_url', org_row.logo_url,
      'subscription_plan_id', org_row.subscription_plan_id,
      'subscription_status', org_row.subscription_status,
      'subscription_started_at', org_row.subscription_started_at,
      'subscription_ends_at', org_row.subscription_ends_at,
      'trial_ends_at', org_row.trial_ends_at,
      'is_suspended', org_row.is_suspended,
      'suspended_at', org_row.suspended_at,
      'suspended_reason', org_row.suspended_reason,
      'role', COALESCE(role_row.role::text, 'staff'),
      'role_id', role_row.role_id,
      'user_type', role_row.user_type,
      'plan', plan_data,
      'app_entitlements', apps,
      'entitled_features', features,
      'overrides', overrides,
      'usage_counters', jsonb_build_object(
        'users_count', user_count,
        'storage_used_mb', storage_used
      ),
      'permission_group_rules', group_rules
    );

    org_array := org_array || jsonb_build_array(org_entry);
  END LOOP;

  result := jsonb_build_object(
    'user_id', p_user_id,
    'is_platform_admin', is_admin,
    'organizations', org_array,
    'fetched_at', now()
  );
  RETURN result;
END
$function$;