
-- ============================================================================
-- Payroll readiness/mapping core overhaul
-- Fixes broken STABLE+TEMP TABLE function, makes service-role install safe,
-- aligns coverage helpers with the canonical readiness engine.
-- ============================================================================

-- ── 1. payroll_gl_readiness: rewrite WITHOUT temp tables, VOLATILE-safe ──
CREATE OR REPLACE FUNCTION public.payroll_gl_readiness(
  _org_id uuid,
  _business_id uuid DEFAULT NULL
)
RETURNS TABLE(
  setting_key text,
  label text,
  rule_code text,
  kind text,
  required_account_type text,
  is_mapped boolean,
  suggested_account_id uuid,
  suggested_account_label text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH rules AS (
    SELECT psr.rule_code,
           psr.rule_name,
           psr.rule_type,
           psr.parameters,
           n.needs_employee,
           n.needs_employer
    FROM public.payroll_statutory_rules psr,
         LATERAL public._payroll_rule_needs(psr) n
    WHERE psr.organization_id = _org_id
      AND psr.is_active = true
      AND (psr.effective_to IS NULL OR psr.effective_to >= CURRENT_DATE)
  ),
  needed AS (
    -- core
    SELECT 'salary_expense'::text     AS setting_key,
           'Salary Expense'::text     AS label,
           NULL::text                 AS rule_code,
           'core'::text               AS kind,
           'expense'::text            AS required_account_type
    UNION ALL
    SELECT 'net_salary_payable', 'Net Salary Payable', NULL, 'core', 'liability'
    UNION ALL
    -- employee payable
    SELECT r.rule_code || '_payable',
           COALESCE(r.rule_name, r.rule_code) || ' — Payable',
           r.rule_code, 'employee_payable', 'liability'
    FROM rules r WHERE r.needs_employee
    UNION ALL
    -- employer expense
    SELECT r.rule_code || '_employer_expense',
           COALESCE(r.rule_name, r.rule_code) || ' — Employer Expense',
           r.rule_code, 'employer_expense', 'expense'
    FROM rules r WHERE r.needs_employer
    UNION ALL
    -- employer payable (when only employer side exists; dedup later)
    SELECT r.rule_code || '_payable',
           COALESCE(r.rule_name, r.rule_code) || ' — Payable',
           r.rule_code, 'employer_payable', 'liability'
    FROM rules r WHERE r.needs_employer AND NOT r.needs_employee
  ),
  needed_dedup AS (
    SELECT DISTINCT ON (setting_key)
      setting_key, label, rule_code, kind, required_account_type
    FROM needed
    ORDER BY setting_key,
             CASE kind WHEN 'core' THEN 0 WHEN 'employee_payable' THEN 1
                       WHEN 'employer_expense' THEN 2 ELSE 3 END
  ),
  effective_mappings AS (
    SELECT DISTINCT ON (das.setting_key)
      das.setting_key, das.account_id
    FROM public.default_account_settings das
    WHERE das.organization_id = _org_id
      AND (_business_id IS NULL
           OR das.business_id IS NULL
           OR das.business_id = _business_id)
    ORDER BY das.setting_key, (das.business_id IS NOT NULL) DESC
  ),
  candidates AS (
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type
    FROM public.accounts a
    WHERE a.organization_id = _org_id
      AND COALESCE(a.is_active, true) = true
      AND COALESCE(a.is_header, false) = false
      AND (_business_id IS NULL OR a.business_id IS NULL OR a.business_id = _business_id)
  ),
  ranked AS (
    SELECT n.setting_key, c.id AS account_id,
           ROW_NUMBER() OVER (
             PARTITION BY n.setting_key
             ORDER BY
               CASE WHEN n.rule_code IS NOT NULL
                         AND (lower(c.name) ILIKE '%'||replace(n.rule_code,'_',' ')||'%'
                              OR lower(c.code) ILIKE '%'||lower(n.rule_code)||'%')
                    THEN 0
                    WHEN lower(c.name) ILIKE '%'||lower(replace(n.setting_key,'_',' '))||'%'
                    THEN 1
                    ELSE 2
               END,
               c.code
           ) AS rn
    FROM needed_dedup n
    JOIN candidates c ON c.account_type = n.required_account_type
  ),
  suggestions AS (
    SELECT setting_key, account_id FROM ranked WHERE rn = 1
  )
  SELECT n.setting_key,
         n.label,
         n.rule_code,
         n.kind,
         n.required_account_type,
         (em.account_id IS NOT NULL) AS is_mapped,
         CASE WHEN em.account_id IS NULL THEN s.account_id END AS suggested_account_id,
         CASE WHEN em.account_id IS NULL THEN
           (SELECT a.code || ' — ' || a.name FROM public.accounts a WHERE a.id = s.account_id)
         END AS suggested_account_label
  FROM needed_dedup n
  LEFT JOIN effective_mappings em ON em.setting_key = n.setting_key
  LEFT JOIN suggestions s ON s.setting_key = n.setting_key
  ORDER BY n.kind, n.setting_key;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_gl_readiness(uuid, uuid) TO authenticated, service_role;

-- ── 2. apply mappings: allow service_role for trusted localization installs ──
CREATE OR REPLACE FUNCTION public.payroll_apply_proposed_mappings(
  _org_id uuid,
  _business_id uuid,
  _accept jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_count integer := 0;
  item jsonb;
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user
        AND ur.organization_id = _org_id
        AND ur.is_active = true
    ) THEN
      RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(_accept,'[]'::jsonb))
  LOOP
    INSERT INTO public.default_account_settings (
      organization_id, business_id, setting_key, account_id
    ) VALUES (
      _org_id, _business_id,
      item->>'setting_key',
      (item->>'account_id')::uuid
    )
    ON CONFLICT (organization_id, business_id, setting_key) DO UPDATE
      SET account_id = EXCLUDED.account_id, updated_at = now();
    v_count := v_count + 1;
  END LOOP;

  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_apply_proposed_mappings(uuid, uuid, jsonb) TO authenticated, service_role;

-- ── 3. create-and-map: allow service_role too, and choose a sensible code ──
CREATE OR REPLACE FUNCTION public.payroll_create_and_map_account(
  _org_id uuid,
  _business_id uuid,
  _setting_key text,
  _name text,
  _account_type text,
  _code text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_account_id uuid;
  v_code text;
  v_prefix text;
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user AND ur.organization_id = _org_id AND ur.is_active = true
    ) THEN
      RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Pick a sensible default code prefix by account_type
  v_prefix := CASE lower(_account_type)
    WHEN 'expense'   THEN '6900'
    WHEN 'liability' THEN '2300'
    WHEN 'asset'     THEN '1900'
    WHEN 'income'    THEN '4900'
    WHEN 'equity'    THEN '3900'
    ELSE '9000'
  END;

  v_code := COALESCE(
    _code,
    v_prefix || '-' || upper(left(regexp_replace(_setting_key,'[^a-zA-Z0-9]','','g'),10))
  );

  IF EXISTS (
    SELECT 1 FROM public.accounts
    WHERE organization_id=_org_id
      AND (business_id IS NULL OR business_id = _business_id)
      AND code=v_code
  ) THEN
    v_code := v_code || '-' || substring(gen_random_uuid()::text,1,4);
  END IF;

  INSERT INTO public.accounts (
    organization_id, business_id, code, name, account_type, is_active, is_header
  ) VALUES (
    _org_id, _business_id, v_code, _name, _account_type::public.account_type_enum, true, false
  )
  RETURNING id INTO v_account_id;

  INSERT INTO public.default_account_settings (
    organization_id, business_id, setting_key, account_id
  ) VALUES (_org_id, _business_id, _setting_key, v_account_id)
  ON CONFLICT (organization_id, business_id, setting_key) DO UPDATE
    SET account_id = EXCLUDED.account_id, updated_at = now();

  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_account_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_create_and_map_account(uuid, uuid, text, text, text, text) TO authenticated, service_role;

-- ── 4. preflight coverage now delegates to canonical readiness ──
CREATE OR REPLACE FUNCTION public.preflight_payroll_account_coverage(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_required text[];
  v_existing text[];
  v_missing  text[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_org_member(auth.uid(), p_org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COALESCE(array_agg(setting_key), ARRAY[]::text[])
    INTO v_required
  FROM public.payroll_gl_readiness(p_org_id, p_business_id);

  SELECT COALESCE(array_agg(setting_key), ARRAY[]::text[])
    INTO v_existing
  FROM public.payroll_gl_readiness(p_org_id, p_business_id)
  WHERE is_mapped;

  SELECT COALESCE(array_agg(setting_key), ARRAY[]::text[])
    INTO v_missing
  FROM public.payroll_gl_readiness(p_org_id, p_business_id)
  WHERE NOT is_mapped;

  RETURN jsonb_build_object(
    'ok', cardinality(v_missing) = 0,
    'required_keys', v_required,
    'existing_keys', v_existing,
    'missing_keys', v_missing
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.preflight_payroll_account_coverage(uuid, uuid) TO authenticated;

-- ── 5. Allow validate_default_account_setting to accept payroll dynamic keys ──
-- Payroll keys (e.g. nssf_..._payable, paye_..._employer_expense, salary_expense,
-- net_salary_payable) are NOT in system_account_roles. Without bypass, manual
-- saves from the mapping UI fail with "Unknown account role". We validate
-- payroll keys via account_type/header/active checks instead.
CREATE OR REPLACE FUNCTION public.validate_default_account_setting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_canonical text;
  v_role record;
  v_account record;
  v_eligible boolean;
  v_is_payroll boolean;
  v_required_type text;
BEGIN
  v_canonical := public.canonicalize_role_key(NEW.setting_key);
  IF v_canonical <> NEW.setting_key THEN
    NEW.setting_key := v_canonical;
  END IF;

  IF NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Detect payroll-engine keys (core + per-statutory-rule).
  v_is_payroll := (
    NEW.setting_key IN ('salary_expense','net_salary_payable','loan_deduction_payable')
    OR NEW.setting_key LIKE '%\_payable' ESCAPE '\'
    OR NEW.setting_key LIKE '%\_employer\_expense' ESCAPE '\'
    OR NEW.setting_key LIKE '%\_expense' ESCAPE '\'
  );

  -- For non-payroll keys, require registry membership.
  IF NOT v_is_payroll AND to_regclass('public.system_account_roles') IS NOT NULL THEN
    SELECT * INTO v_role FROM public.system_account_roles WHERE role_key = NEW.setting_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown account role "%": not registered in system_account_roles', NEW.setting_key
        USING ERRCODE = '22023';
    END IF;
  ELSIF v_is_payroll AND to_regclass('public.system_account_roles') IS NOT NULL THEN
    -- Soft lookup; payroll keys won't be in the registry.
    SELECT * INTO v_role FROM public.system_account_roles WHERE role_key = NEW.setting_key;
  END IF;

  SELECT a.id, a.code, a.name, a.account_type::text AS account_type, a.detail_type,
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

  IF v_is_payroll THEN
    -- Infer required type from the suffix.
    v_required_type := CASE
      WHEN NEW.setting_key = 'salary_expense'                 THEN 'expense'
      WHEN NEW.setting_key = 'net_salary_payable'             THEN 'liability'
      WHEN NEW.setting_key LIKE '%\_employer\_expense' ESCAPE '\' THEN 'expense'
      WHEN NEW.setting_key LIKE '%\_expense' ESCAPE '\'        THEN 'expense'
      WHEN NEW.setting_key LIKE '%\_payable' ESCAPE '\'        THEN 'liability'
      ELSE NULL
    END;

    IF v_required_type IS NOT NULL
       AND v_account.account_type IS DISTINCT FROM v_required_type THEN
      RAISE EXCEPTION 'Account %/% has account_type % but role "%" requires %',
        v_account.code, v_account.name, v_account.account_type, NEW.setting_key, v_required_type
        USING ERRCODE = '22023';
    END IF;

    RETURN NEW;
  END IF;

  -- Non-payroll: keep stricter eligibility checks.
  IF to_regclass('public.account_role_eligibility') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.account_role_eligibility e
      WHERE e.role_key = NEW.setting_key AND e.detail_type = v_account.detail_type
    ) INTO v_eligible;

    IF NOT v_eligible THEN
      RAISE EXCEPTION 'Account %/% (detail_type=%) is not eligible for role "%". Pick an account whose detail type matches the role.',
        v_account.code, v_account.name, coalesce(v_account.detail_type::text,'NULL'), NEW.setting_key
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_role.required_account_type IS NOT NULL
     AND v_account.account_type IS DISTINCT FROM v_role.required_account_type::text THEN
    RAISE EXCEPTION 'Account %/% has account_type % but role "%" requires %',
      v_account.code, v_account.name, v_account.account_type, NEW.setting_key, v_role.required_account_type
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$function$;

-- ── 6. enforce_default_account_shape: skip payroll dynamic keys ──
-- Old shape rules don't know about payroll keys; handled by validate_default_account_setting now.
-- (No change to function body needed; trigger only switches on a closed list of keys via CASE.)

-- ── 7. prevent_unmapped_system_role_delete: payroll keys are not "required" core ──
-- (Already only protects: cash, bank, accounts_receivable, accounts_payable,
--  sales_revenue, retained_earnings — leave as-is.)
