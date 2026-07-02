-- =====================================================================
-- 1. Canonical alias map for system account roles
-- =====================================================================
CREATE OR REPLACE FUNCTION public.canonicalize_role_key(_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(coalesce(_key, ''))
    WHEN 'cost_of_goods_sold'      THEN 'cogs'
    WHEN 'sales_tax_payable'       THEN 'output_tax'
    WHEN 'vat_payable'             THEN 'output_tax'
    WHEN 'purchase_tax_receivable' THEN 'input_tax'
    WHEN 'vat_receivable'          THEN 'input_tax'
    WHEN 'pos_cash'                THEN 'cash'
    WHEN 'pos_clearing'            THEN 'clearing_pos'
    WHEN 'undeposited_funds'       THEN 'clearing_undeposited_funds'
    WHEN 'card_clearing'           THEN 'credit_card_clearing'
    ELSE lower(_key)
  END;
$$;

-- =====================================================================
-- 2. Canonicalize existing default_account_settings keys
--    (safe: only rewrites known aliases; skips if canonical row already exists)
-- =====================================================================
DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.default_account_settings') IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT id, organization_id, business_id, setting_key,
           public.canonicalize_role_key(setting_key) AS canonical_key
    FROM public.default_account_settings
    WHERE setting_key <> public.canonicalize_role_key(setting_key)
  LOOP
    -- Delete duplicates if a canonical row already exists for same scope
    IF EXISTS (
      SELECT 1 FROM public.default_account_settings d
      WHERE d.organization_id IS NOT DISTINCT FROM r.organization_id
        AND d.business_id     IS NOT DISTINCT FROM r.business_id
        AND d.setting_key = r.canonical_key
        AND d.id <> r.id
    ) THEN
      DELETE FROM public.default_account_settings WHERE id = r.id;
    ELSE
      UPDATE public.default_account_settings
        SET setting_key = r.canonical_key
        WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

-- =====================================================================
-- 3. Hardened validator — replaces name-regex acceptance with strict
--    role registry + detail_type eligibility + header/inactive rejection
-- =====================================================================
CREATE OR REPLACE FUNCTION public.validate_default_account_setting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_canonical text;
  v_role record;
  v_account record;
  v_eligible boolean;
BEGIN
  -- Canonicalize key first
  v_canonical := public.canonicalize_role_key(NEW.setting_key);
  IF v_canonical <> NEW.setting_key THEN
    NEW.setting_key := v_canonical;
  END IF;

  -- Allow null clears
  IF NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Reject unknown role keys when registry exists
  IF to_regclass('public.system_account_roles') IS NOT NULL THEN
    SELECT * INTO v_role
    FROM public.system_account_roles
    WHERE role_key = NEW.setting_key;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown account role "%": not registered in system_account_roles', NEW.setting_key
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Load the candidate account
  SELECT a.id, a.code, a.name, a.account_type, a.detail_type,
         coalesce(a.is_header, false) AS is_header,
         coalesce(a.is_active, true)  AS is_active,
         a.organization_id, a.business_id
    INTO v_account
  FROM public.accounts a
  WHERE a.id = NEW.account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account % not found', NEW.account_id USING ERRCODE = '23503';
  END IF;

  IF v_account.is_header THEN
    RAISE EXCEPTION 'Cannot map role "%": account %/% is a header (group) account and is not postable. Pick a leaf child instead.',
      NEW.setting_key, v_account.code, v_account.name
      USING ERRCODE = '22023';
  END IF;

  IF NOT v_account.is_active THEN
    RAISE EXCEPTION 'Cannot map role "%": account %/% is inactive.',
      NEW.setting_key, v_account.code, v_account.name
      USING ERRCODE = '22023';
  END IF;

  -- Scope checks
  IF NEW.organization_id IS NOT NULL
     AND v_account.organization_id IS NOT NULL
     AND NEW.organization_id <> v_account.organization_id THEN
    RAISE EXCEPTION 'Account %/% belongs to a different organization', v_account.code, v_account.name
      USING ERRCODE = '22023';
  END IF;

  IF NEW.business_id IS NOT NULL
     AND v_account.business_id IS NOT NULL
     AND NEW.business_id <> v_account.business_id THEN
    RAISE EXCEPTION 'Account %/% belongs to a different business', v_account.code, v_account.name
      USING ERRCODE = '22023';
  END IF;

  -- Role-specific checks via account_role_eligibility (when registry present)
  IF to_regclass('public.account_role_eligibility') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.account_role_eligibility e
      WHERE e.role_key = NEW.setting_key
        AND e.detail_type = v_account.detail_type
    ) INTO v_eligible;

    IF NOT v_eligible THEN
      RAISE EXCEPTION 'Account %/% (detail_type=%) is not eligible for role "%". Pick an account whose detail type matches the role.',
        v_account.code, v_account.name, coalesce(v_account.detail_type::text,'NULL'), NEW.setting_key
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Required account_type from role registry
  IF v_role.required_account_type IS NOT NULL
     AND v_account.account_type IS DISTINCT FROM v_role.required_account_type THEN
    RAISE EXCEPTION 'Account %/% has account_type % but role "%" requires %',
      v_account.code, v_account.name, v_account.account_type, NEW.setting_key, v_role.required_account_type
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END
$$;

-- =====================================================================
-- 4. Repair COA detail-type pollution (fixed assets wrongly = accounts_receivable)
-- =====================================================================
DO $$
BEGIN
  IF to_regclass('public.accounts') IS NULL THEN
    RETURN;
  END IF;

  -- Land / Buildings
  UPDATE public.accounts
    SET detail_type = 'buildings'
    WHERE detail_type = 'accounts_receivable'
      AND (lower(name) LIKE '%land%' OR lower(name) LIKE '%building%');

  -- Vehicles
  UPDATE public.accounts
    SET detail_type = 'vehicles'
    WHERE detail_type = 'accounts_receivable'
      AND lower(name) LIKE '%vehicle%';

  -- Furniture & Fixtures
  UPDATE public.accounts
    SET detail_type = 'furniture_fixtures'
    WHERE detail_type = 'accounts_receivable'
      AND (lower(name) LIKE '%furniture%' OR lower(name) LIKE '%fixture%');

  -- Computer / IT equipment → machinery_equipment if catalog lacks computers
  UPDATE public.accounts
    SET detail_type = 'machinery_equipment'
    WHERE detail_type = 'accounts_receivable'
      AND (lower(name) LIKE '%computer%' OR lower(name) LIKE '%it equipment%' OR lower(name) LIKE '%laptop%');

  -- Accumulated depreciation
  UPDATE public.accounts
    SET detail_type = 'accumulated_depreciation'
    WHERE detail_type = 'accounts_receivable'
      AND lower(name) LIKE '%accumulated depreciation%';

  -- Non-current asset header rows wrongly tagged AR
  UPDATE public.accounts
    SET detail_type = NULL,
        is_header = true
    WHERE detail_type = 'accounts_receivable'
      AND (
        lower(name) LIKE '%non-current asset%'
        OR lower(name) LIKE '%property, plant%'
        OR lower(name) = 'ppe'
        OR lower(name) LIKE '%fixed asset%'
      );
EXCEPTION WHEN OTHERS THEN
  -- enum/detail_type catalog may differ; never block migration
  RAISE NOTICE 'COA detail-type repair partial: %', SQLERRM;
END $$;

-- =====================================================================
-- 5. POS resolver — canonical role keys + populate debit_account_id
-- =====================================================================
DO $$
BEGIN
  IF to_regprocedure('public.pos_apply_default_method_gl(uuid,uuid)') IS NOT NULL THEN
    EXECUTE 'DROP FUNCTION public.pos_apply_default_method_gl(uuid,uuid)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pos_apply_default_method_gl(_org_id uuid, _business_id uuid)
RETURNS TABLE (method_id uuid, method_code text, resolved_role text, account_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m record;
  v_role text;
  v_acct uuid;
BEGIN
  IF to_regclass('public.pos_payment_methods') IS NULL THEN
    RETURN;
  END IF;

  FOR m IN
    SELECT id, code, lower(coalesce(method_type, code)) AS kind, is_enabled
    FROM public.pos_payment_methods
    WHERE (organization_id IS NOT DISTINCT FROM _org_id)
      AND (business_id IS NOT DISTINCT FROM _business_id)
  LOOP
    v_role := CASE
      WHEN m.kind IN ('cash','pos_cash')             THEN 'cash'
      WHEN m.kind IN ('card','credit_card','debit_card') THEN 'credit_card_clearing'
      WHEN m.kind IN ('mpesa','m-pesa')              THEN 'mpesa'
      WHEN m.kind IN ('mobile_money','momo')         THEN 'mobile_money'
      WHEN m.kind IN ('bank','bank_transfer','eft','check','cheque') THEN 'bank'
      ELSE 'clearing_undeposited_funds'
    END;

    SELECT account_id INTO v_acct
    FROM public.default_account_settings
    WHERE setting_key = v_role
      AND (organization_id IS NOT DISTINCT FROM _org_id)
      AND (business_id     IS NOT DISTINCT FROM _business_id)
    LIMIT 1;

    -- Fallback to clearing_undeposited_funds for non-cash methods
    IF v_acct IS NULL AND v_role <> 'cash' AND v_role <> 'bank' THEN
      SELECT account_id INTO v_acct
      FROM public.default_account_settings
      WHERE setting_key = 'clearing_undeposited_funds'
        AND (organization_id IS NOT DISTINCT FROM _org_id)
        AND (business_id     IS NOT DISTINCT FROM _business_id)
      LIMIT 1;
    END IF;

    IF v_acct IS NOT NULL AND m.is_enabled THEN
      UPDATE public.pos_payment_methods
        SET debit_account_id = v_acct
        WHERE id = m.id
          AND (debit_account_id IS NULL OR debit_account_id <> v_acct);
    END IF;

    method_id := m.id;
    method_code := m.code;
    resolved_role := v_role;
    account_id := v_acct;
    RETURN NEXT;
  END LOOP;
END
$$;

-- =====================================================================
-- 6. Diagnostics — surface actionable issues to the UI
-- =====================================================================
DROP FUNCTION IF EXISTS public.diagnose_default_account_mappings(uuid, uuid);

CREATE OR REPLACE FUNCTION public.diagnose_default_account_mappings(_org_id uuid, _business_id uuid)
RETURNS TABLE (
  issue_type text,
  setting_key text,
  account_id uuid,
  account_code text,
  account_name text,
  detail text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Missing mandatory roles
  IF to_regclass('public.system_account_roles') IS NOT NULL THEN
    RETURN QUERY
      SELECT 'missing_mandatory'::text,
             r.role_key,
             NULL::uuid, NULL::text, NULL::text,
             'Mandatory role "' || r.role_key || '" has no mapping'::text
      FROM public.system_account_roles r
      WHERE coalesce(r.is_mandatory, false) = true
        AND NOT EXISTS (
          SELECT 1 FROM public.default_account_settings d
          WHERE d.setting_key = r.role_key
            AND (d.organization_id IS NOT DISTINCT FROM _org_id)
            AND (d.business_id     IS NOT DISTINCT FROM _business_id)
            AND d.account_id IS NOT NULL
        );

    -- Unknown role keys still stored
    RETURN QUERY
      SELECT 'unknown_role'::text,
             d.setting_key,
             d.account_id, a.code, a.name,
             'Stored key "' || d.setting_key || '" is not registered in system_account_roles'::text
      FROM public.default_account_settings d
      LEFT JOIN public.accounts a ON a.id = d.account_id
      WHERE (d.organization_id IS NOT DISTINCT FROM _org_id)
        AND (d.business_id     IS NOT DISTINCT FROM _business_id)
        AND NOT EXISTS (SELECT 1 FROM public.system_account_roles r WHERE r.role_key = d.setting_key);
  END IF;

  -- Header / inactive mapped accounts
  RETURN QUERY
    SELECT CASE WHEN coalesce(a.is_header,false) THEN 'header_mapped' ELSE 'inactive_mapped' END::text,
           d.setting_key, d.account_id, a.code, a.name,
           CASE WHEN coalesce(a.is_header,false)
                THEN 'Mapped account is a header — pick a leaf child'
                ELSE 'Mapped account is inactive' END
    FROM public.default_account_settings d
    JOIN public.accounts a ON a.id = d.account_id
    WHERE (d.organization_id IS NOT DISTINCT FROM _org_id)
      AND (d.business_id     IS NOT DISTINCT FROM _business_id)
      AND (coalesce(a.is_header,false) OR coalesce(a.is_active,true) = false);

  -- Wrong detail type vs eligibility
  IF to_regclass('public.account_role_eligibility') IS NOT NULL THEN
    RETURN QUERY
      SELECT 'detail_type_mismatch'::text,
             d.setting_key, d.account_id, a.code, a.name,
             'detail_type=' || coalesce(a.detail_type::text,'NULL') || ' is not eligible for role'
      FROM public.default_account_settings d
      JOIN public.accounts a ON a.id = d.account_id
      WHERE (d.organization_id IS NOT DISTINCT FROM _org_id)
        AND (d.business_id     IS NOT DISTINCT FROM _business_id)
        AND NOT EXISTS (
          SELECT 1 FROM public.account_role_eligibility e
          WHERE e.role_key = d.setting_key AND e.detail_type = a.detail_type
        );
  END IF;
END
$$;

GRANT EXECUTE ON FUNCTION public.canonicalize_role_key(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.diagnose_default_account_mappings(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pos_apply_default_method_gl(uuid, uuid) TO authenticated;
