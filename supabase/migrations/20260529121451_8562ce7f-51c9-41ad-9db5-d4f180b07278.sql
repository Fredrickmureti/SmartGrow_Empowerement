
-- ============================================================
-- Finance Readiness Contract — Phase A
-- ============================================================
-- 1. Add readiness columns to businesses
-- 2. repair_finance_setup: idempotent, server-side, country-agnostic
-- 3. get_finance_readiness: read-only status RPC for UI
-- 4. Rewrite provision_company_full to delegate to repair_finance_setup
-- 5. Backfill: self-heal every existing business that is empty/pending
-- ============================================================

-- 1. Columns ---------------------------------------------------------
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS finance_readiness text
    NOT NULL DEFAULT 'pending'
    CHECK (finance_readiness IN ('pending','ready','degraded')),
  ADD COLUMN IF NOT EXISTS finance_readiness_reason text,
  ADD COLUMN IF NOT EXISTS finance_readiness_checked_at timestamptz;

COMMENT ON COLUMN public.businesses.finance_readiness IS
  'Deterministic finance bootstrap state. pending = never provisioned; ready = all mandatory system roles have a mapped account; degraded = provisioning ran but mandatory roles are still missing. Driven exclusively by repair_finance_setup.';

-- 2. repair_finance_setup --------------------------------------------
-- Idempotent. Re-runnable from UI ("Repair Finance Setup") and
-- automatically by provision_company_full at signup.
CREATE OR REPLACE FUNCTION public.repair_finance_setup(
  _org_id uuid,
  _business_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _country text;
  _accounts_before int := 0;
  _accounts_after int := 0;
  _mappings_seeded int := 0;
  _mandatory_missing text[] := '{}';
  _readiness text;
  _reason text;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'org_id and business_id are required';
  END IF;

  SELECT upper(coalesce(country, 'INT'))
    INTO _country
    FROM public.businesses
   WHERE id = _business_id AND organization_id = _org_id;

  IF _country IS NULL THEN
    RAISE EXCEPTION 'Business % not found for organization %', _business_id, _org_id;
  END IF;

  SELECT count(*) INTO _accounts_before
    FROM public.accounts WHERE business_id = _business_id;

  -- (a) Tier-1 country-neutral CoA. The provisioner already filters
  -- statutory account names, so this is safe for any country.
  BEGIN
    PERFORM public.provision_default_chart_of_accounts(_org_id, _business_id, _country);
  EXCEPTION WHEN OTHERS THEN
    _reason := 'provision_default_chart_of_accounts: ' || SQLERRM;
  END;

  -- (b) Role coverage. Creates any missing mandatory system accounts.
  BEGIN
    PERFORM public.provision_missing_system_accounts(_org_id, _business_id, false);
  EXCEPTION WHEN OTHERS THEN
    _reason := coalesce(_reason || ' | ', '') || 'provision_missing_system_accounts: ' || SQLERRM;
  END;

  -- (c) Auto-map every role-bearing account that does not yet have a
  -- default_account_settings row. setting_key === system_role.
  WITH ins AS (
    INSERT INTO public.default_account_settings
      (organization_id, business_id, branch_id, setting_key, account_id)
    SELECT a.organization_id, a.business_id, NULL, a.system_role, a.id
      FROM public.accounts a
     WHERE a.business_id = _business_id
       AND a.is_active = true
       AND a.system_role IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.default_account_settings d
          WHERE d.business_id = a.business_id
            AND d.branch_id IS NULL
            AND d.setting_key = a.system_role
       )
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO _mappings_seeded FROM ins;

  SELECT count(*) INTO _accounts_after
    FROM public.accounts WHERE business_id = _business_id;

  -- (d) Compute mandatory-role coverage.
  SELECT coalesce(array_agg(r.role_key ORDER BY r.role_key), '{}')
    INTO _mandatory_missing
    FROM public.system_account_roles r
   WHERE r.is_mandatory = true
     AND NOT EXISTS (
       SELECT 1 FROM public.default_account_settings d
         JOIN public.accounts a ON a.id = d.account_id AND a.is_active = true
        WHERE d.business_id = _business_id
          AND d.setting_key = r.role_key
     );

  IF cardinality(_mandatory_missing) = 0 THEN
    _readiness := 'ready';
    _reason := NULL;
  ELSE
    _readiness := 'degraded';
    _reason := coalesce(_reason, 'Mandatory roles unmapped: ' || array_to_string(_mandatory_missing, ', '));
  END IF;

  UPDATE public.businesses
     SET finance_readiness = _readiness,
         finance_readiness_reason = _reason,
         finance_readiness_checked_at = now()
   WHERE id = _business_id;

  RETURN jsonb_build_object(
    'business_id', _business_id,
    'readiness', _readiness,
    'reason', _reason,
    'country', _country,
    'accounts_before', _accounts_before,
    'accounts_after', _accounts_after,
    'accounts_created', _accounts_after - _accounts_before,
    'mappings_seeded', _mappings_seeded,
    'mandatory_missing', to_jsonb(_mandatory_missing)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.repair_finance_setup(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.repair_finance_setup(uuid, uuid) IS
  'Idempotent, country-agnostic finance bootstrap. Provisions the Tier-1 CoA, ensures every mandatory system role has an account, auto-maps role-bearing accounts into default_account_settings, and updates businesses.finance_readiness. Safe to call from onboarding, the UI repair banner, and after localization-pack installs.';

-- 3. get_finance_readiness -------------------------------------------
CREATE OR REPLACE FUNCTION public.get_finance_readiness(_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _biz public.businesses%ROWTYPE;
  _accounts_count int := 0;
  _total_roles int := 0;
  _mapped_roles int := 0;
  _mandatory_missing text[] := '{}';
  _unmapped_roles text[] := '{}';
BEGIN
  SELECT * INTO _biz FROM public.businesses WHERE id = _business_id;
  IF _biz.id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id;
  END IF;

  SELECT count(*) INTO _accounts_count
    FROM public.accounts WHERE business_id = _business_id AND is_active = true;

  SELECT count(*) INTO _total_roles FROM public.system_account_roles;

  SELECT count(DISTINCT r.role_key) INTO _mapped_roles
    FROM public.system_account_roles r
    JOIN public.default_account_settings d ON d.setting_key = r.role_key
    JOIN public.accounts a ON a.id = d.account_id AND a.is_active = true
   WHERE d.business_id = _business_id;

  SELECT coalesce(array_agg(r.role_key ORDER BY r.role_key), '{}')
    INTO _mandatory_missing
    FROM public.system_account_roles r
   WHERE r.is_mandatory = true
     AND NOT EXISTS (
       SELECT 1 FROM public.default_account_settings d
         JOIN public.accounts a ON a.id = d.account_id AND a.is_active = true
        WHERE d.business_id = _business_id AND d.setting_key = r.role_key
     );

  SELECT coalesce(array_agg(r.role_key ORDER BY r.role_key), '{}')
    INTO _unmapped_roles
    FROM public.system_account_roles r
   WHERE NOT EXISTS (
       SELECT 1 FROM public.default_account_settings d
         JOIN public.accounts a ON a.id = d.account_id AND a.is_active = true
        WHERE d.business_id = _business_id AND d.setting_key = r.role_key
     );

  RETURN jsonb_build_object(
    'business_id', _business_id,
    'readiness', _biz.finance_readiness,
    'reason', _biz.finance_readiness_reason,
    'checked_at', _biz.finance_readiness_checked_at,
    'accounts_count', _accounts_count,
    'total_roles', _total_roles,
    'mapped_roles', _mapped_roles,
    'mandatory_missing', to_jsonb(_mandatory_missing),
    'unmapped_roles', to_jsonb(_unmapped_roles)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_finance_readiness(uuid) TO authenticated;

-- 4. Rewrite provision_company_full to delegate to repair_finance_setup
CREATE OR REPLACE FUNCTION public.provision_company_full(
  _org_id uuid,
  _name text,
  _country text,
  _currency text,
  _business_type text DEFAULT NULL::text,
  _legal_name text DEFAULT NULL::text,
  _is_first boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business_id uuid;
  v_branch_id uuid;
  v_user_id uuid := auth.uid();
  v_repair jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.countries WHERE upper(code) = upper(_country) AND is_active = true) THEN
    RAISE EXCEPTION 'Invalid country code: % (must be a valid ISO-3166 code)', _country;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currencies WHERE upper(code) = upper(_currency) AND is_active = true) THEN
    RAISE EXCEPTION 'Invalid currency code: % (must be a valid ISO-4217 code)', _currency;
  END IF;

  INSERT INTO public.businesses (
    organization_id, name, legal_name, country, base_currency, business_type, is_active
  )
  VALUES (
    _org_id, _name, COALESCE(NULLIF(_legal_name,''), _name),
    upper(_country), upper(_currency), NULLIF(_business_type,''), true
  )
  RETURNING id INTO v_business_id;

  INSERT INTO public.user_business_access (
    user_id, organization_id, business_id, is_primary, can_switch, role, can_post
  )
  VALUES (v_user_id, _org_id, v_business_id, _is_first, true, 'admin', true)
  ON CONFLICT (user_id, business_id) DO UPDATE
    SET can_switch = true,
        can_post   = true,
        role       = 'admin',
        is_primary = user_business_access.is_primary OR EXCLUDED.is_primary;

  SELECT id INTO v_branch_id
    FROM public.branches
   WHERE business_id = v_business_id AND is_headquarters = true
   ORDER BY created_at ASC LIMIT 1;

  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'HQ branch was not auto-provisioned for business % (trigger_create_default_branch missing?)', v_business_id;
  END IF;

  INSERT INTO public.user_branch_assignments (
    user_id, organization_id, business_id, branch_id,
    is_primary, can_view, can_manage, assigned_by
  ) VALUES (
    v_user_id, _org_id, v_business_id, v_branch_id,
    true, true, true, v_user_id
  )
  ON CONFLICT (user_id, branch_id) DO UPDATE
    SET is_primary = true, can_view = true, can_manage = true;

  -- Single, observable finance-bootstrap entry point.
  -- repair_finance_setup updates businesses.finance_readiness so any
  -- partial failure is surfaced to the UI banner instead of being
  -- swallowed by a RAISE NOTICE.
  BEGIN
    v_repair := public.repair_finance_setup(_org_id, v_business_id);
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.businesses
       SET finance_readiness = 'degraded',
           finance_readiness_reason = 'repair_finance_setup raised: ' || SQLERRM,
           finance_readiness_checked_at = now()
     WHERE id = v_business_id;
  END;

  BEGIN
    PERFORM public.provision_default_fiscal_periods(_org_id, v_business_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Fiscal periods provisioning failed for business %: %', v_business_id, SQLERRM;
  END;

  BEGIN
    INSERT INTO public.warehouses (
      organization_id, business_id, branch_id, code, name,
      is_default, is_active, is_in_transit
    ) VALUES (
      _org_id, v_business_id, v_branch_id, 'WH-TRANSIT', 'In-Transit',
      false, true, true
    )
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Transit warehouse seeding failed for business %: %', v_business_id, SQLERRM;
  END;

  RETURN v_business_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.provision_company_full(uuid, text, text, text, text, text, boolean) TO authenticated;

-- 5. Backfill --------------------------------------------------------
-- Self-heal every existing business whose finance is empty or pending.
-- Runs the same idempotent path the UI Repair button will use.
DO $backfill$
DECLARE
  _row record;
  _result jsonb;
BEGIN
  FOR _row IN
    SELECT b.id AS business_id, b.organization_id
      FROM public.businesses b
     WHERE b.finance_readiness IS NULL
        OR b.finance_readiness = 'pending'
        OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.business_id = b.id)
  LOOP
    BEGIN
      _result := public.repair_finance_setup(_row.organization_id, _row.business_id);
      RAISE NOTICE 'Backfilled business %: %', _row.business_id, _result;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Backfill failed for business %: %', _row.business_id, SQLERRM;
    END;
  END LOOP;
END;
$backfill$;
