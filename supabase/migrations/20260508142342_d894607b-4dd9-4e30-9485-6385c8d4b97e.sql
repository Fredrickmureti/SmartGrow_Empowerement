
-- ============================================================================
-- Payroll GL readiness — proactive mapping checks + suggestions
-- ============================================================================

-- 1. Helper: classify a statutory rule into which mapping keys it needs.
CREATE OR REPLACE FUNCTION public._payroll_rule_needs(p_rule public.payroll_statutory_rules)
RETURNS TABLE(needs_employee boolean, needs_employer boolean)
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  params jsonb := COALESCE(p_rule.parameters, '{}'::jsonb);
  emp_only boolean := COALESCE((params->>'employer_only')::boolean, false);
  ee_only boolean  := COALESCE((params->>'employee_only')::boolean, false);
  has_er boolean :=
    p_rule.rule_type IN ('employer_contribution')
    OR (params ? 'employer_rate' AND COALESCE((params->>'employer_rate')::numeric,0) > 0)
    OR (params ? 'employer_amount' AND COALESCE((params->>'employer_amount')::numeric,0) > 0)
    OR emp_only
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(params->'tiers','[]'::jsonb)) t
      WHERE COALESCE((t->>'employer_rate')::numeric,0) > 0
         OR COALESCE((t->>'employer_amount')::numeric,0) > 0
    );
BEGIN
  needs_employee := NOT emp_only;
  needs_employer := has_er AND NOT ee_only;
  RETURN NEXT;
END;
$$;

-- 2. Main readiness function
CREATE OR REPLACE FUNCTION public.payroll_gl_readiness(
  _org_id uuid,
  _business_id uuid DEFAULT NULL
)
RETURNS TABLE(
  setting_key text,
  label text,
  rule_code text,
  kind text,            -- 'core' | 'employee_payable' | 'employer_expense' | 'employer_payable'
  required_account_type text,
  is_mapped boolean,
  suggested_account_id uuid,
  suggested_account_label text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  -- Build a temp set of required keys
  CREATE TEMP TABLE _needed (
    setting_key text,
    label text,
    rule_code text,
    kind text,
    required_account_type text
  ) ON COMMIT DROP;

  -- Core keys (always required)
  INSERT INTO _needed VALUES
    ('salary_expense',     'Salary Expense',     NULL, 'core', 'expense'),
    ('net_salary_payable', 'Net Salary Payable', NULL, 'core', 'liability');

  -- Per-active-rule keys
  FOR r IN
    SELECT psr.rule_code, psr.rule_name, psr.rule_type, psr.parameters,
           n.needs_employee, n.needs_employer
    FROM public.payroll_statutory_rules psr,
         LATERAL public._payroll_rule_needs(psr) n
    WHERE psr.organization_id = _org_id
      AND psr.is_active = true
      AND (psr.effective_to IS NULL OR psr.effective_to >= CURRENT_DATE)
  LOOP
    IF r.needs_employee THEN
      INSERT INTO _needed VALUES (
        r.rule_code || '_payable',
        COALESCE(r.rule_name, r.rule_code) || ' — Payable',
        r.rule_code, 'employee_payable', 'liability'
      );
    END IF;
    IF r.needs_employer THEN
      INSERT INTO _needed VALUES (
        r.rule_code || '_employer_expense',
        COALESCE(r.rule_name, r.rule_code) || ' — Employer Expense',
        r.rule_code, 'employer_expense', 'expense'
      );
      -- Employer payable shares the *_payable key with employee side; only insert
      -- once if employee side didn't already add it.
      INSERT INTO _needed
      SELECT r.rule_code || '_payable',
             COALESCE(r.rule_name, r.rule_code) || ' — Payable',
             r.rule_code, 'employer_payable', 'liability'
      WHERE NOT EXISTS (
        SELECT 1 FROM _needed WHERE setting_key = r.rule_code || '_payable'
      );
    END IF;
  END LOOP;

  RETURN QUERY
  WITH effective_mappings AS (
    -- Business-level mapping wins over org-level
    SELECT DISTINCT ON (das.setting_key)
      das.setting_key, das.account_id
    FROM public.default_account_settings das
    WHERE das.organization_id = _org_id
      AND (_business_id IS NULL
           OR das.business_id IS NULL
           OR das.business_id = _business_id)
    ORDER BY das.setting_key,
             (das.business_id IS NOT NULL) DESC  -- prefer business-scoped
  ),
  candidates AS (
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type
    FROM public.accounts a
    WHERE a.organization_id = _org_id
      AND a.is_active = true
      AND a.is_header = false
      AND (a.business_id IS NULL OR a.business_id = _business_id)
  ),
  suggestions AS (
    SELECT n.setting_key,
           (
             SELECT c.id FROM candidates c
             WHERE c.account_type = n.required_account_type
             ORDER BY
               -- Strong fuzzy match on code/name vs the key/label/rule_code
               CASE WHEN n.rule_code IS NOT NULL
                         AND (lower(c.name) ILIKE '%'||replace(n.rule_code,'_',' ')||'%'
                              OR lower(c.code) ILIKE '%'||lower(n.rule_code)||'%')
                    THEN 0
                    WHEN lower(c.name) ILIKE '%'||lower(replace(n.setting_key,'_',' '))||'%'
                    THEN 1
                    ELSE 2
               END,
               c.code
             LIMIT 1
           ) AS suggested_account_id
    FROM _needed n
  )
  SELECT n.setting_key,
         n.label,
         n.rule_code,
         n.kind,
         n.required_account_type,
         (em.account_id IS NOT NULL) AS is_mapped,
         CASE WHEN em.account_id IS NULL THEN s.suggested_account_id END,
         CASE WHEN em.account_id IS NULL THEN
           (SELECT a.code || ' — ' || a.name FROM public.accounts a WHERE a.id = s.suggested_account_id)
         END
  FROM _needed n
  LEFT JOIN effective_mappings em ON em.setting_key = n.setting_key
  LEFT JOIN suggestions s ON s.setting_key = n.setting_key
  ORDER BY n.kind, n.setting_key;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_gl_readiness(uuid, uuid) TO authenticated;

-- 3. Bulk apply mappings (permission-gated)
CREATE OR REPLACE FUNCTION public.payroll_apply_proposed_mappings(
  _org_id uuid,
  _business_id uuid,
  _accept jsonb       -- [{ "setting_key": "...", "account_id": "uuid" }]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_count integer := 0;
  item jsonb;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Permission check: must have managePayroll on this org
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_user
      AND ur.organization_id = _org_id
      AND ur.is_active = true
  ) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
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

  -- Refresh payroll setup status so gates re-evaluate
  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_apply_proposed_mappings(uuid, uuid, jsonb) TO authenticated;

-- 4. Create-and-map: provisions a new account + maps it
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
  v_account_id uuid;
  v_code text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_user AND ur.organization_id = _org_id AND ur.is_active = true
  ) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  v_code := COALESCE(_code, upper(left(regexp_replace(_setting_key,'[^a-zA-Z0-9]','','g'),12)));
  -- Ensure code unique within org
  IF EXISTS (SELECT 1 FROM public.accounts WHERE organization_id=_org_id AND code=v_code) THEN
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

GRANT EXECUTE ON FUNCTION public.payroll_create_and_map_account(uuid, uuid, text, text, text, text) TO authenticated;

-- 5. Extend refresh_payroll_setup_status with GL-key checks
CREATE OR REPLACE FUNCTION public.refresh_payroll_setup_status(p_org_id uuid, p_business_id uuid DEFAULT NULL::uuid)
RETURNS app_setup_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reasons jsonb := '[]'::jsonb;
  v_row public.app_setup_status;
  v_missing record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.installed_localization_packs WHERE organization_id = p_org_id) THEN
    v_reasons := v_reasons || jsonb_build_array('Install a localization pack');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.salary_structures WHERE organization_id = p_org_id AND is_active = true) THEN
    v_reasons := v_reasons || jsonb_build_array('Define a salary structure');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_statutory_rules
    WHERE organization_id = p_org_id
      AND is_active = true
      AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  ) THEN
    v_reasons := v_reasons || jsonb_build_array('Configure statutory rules');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.employee_contracts
    WHERE organization_id = p_org_id
      AND status IN ('running', 'new', 'active')
      AND (p_business_id IS NULL OR business_id = p_business_id)
  ) THEN
    v_reasons := v_reasons || jsonb_build_array('Create an active employee contract');
  END IF;

  -- NEW: per-key GL mapping checks
  FOR v_missing IN
    SELECT setting_key, label
    FROM public.payroll_gl_readiness(p_org_id, p_business_id)
    WHERE is_mapped = false
    ORDER BY kind, setting_key
  LOOP
    v_reasons := v_reasons || jsonb_build_array(
      'Missing GL mapping: ' || v_missing.label || ' (' || v_missing.setting_key || ')'
    );
  END LOOP;

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
