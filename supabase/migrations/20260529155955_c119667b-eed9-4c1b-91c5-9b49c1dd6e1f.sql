
-- =====================================================================
-- Payroll ↔ Finance Re-Audit Fixes (v3 — fixed dedup partition)
-- =====================================================================

-- 1. Register the three missing core roles
INSERT INTO public.system_account_roles
  (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
VALUES
  ('salary_expense',     'Salary Expense',     'Gross salaries & wages expense booked from payroll runs.', 'expense',   true,  'payroll', 500),
  ('net_salary_payable', 'Net Salary Payable', 'Liability for net pay owed to employees until payment is disbursed.', 'liability', true,  'payroll', 510),
  ('payroll_clearing',   'Payroll Clearing',   'Suspense liability used to balance multi-step payroll postings.',     'liability', false, 'payroll', 520)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.system_account_template
  (role_key, suggested_code, suggested_name, account_type, detail_type, parent_code_hint, description)
VALUES
  ('salary_expense',     '6100', 'Salaries & Wages',   'expense',   'payroll_wage_expense', '6000', 'Gross salaries & wages booked from payroll.'),
  ('net_salary_payable', '2170', 'Net Salary Payable', 'liability', 'payroll_clearing',     '2100', 'Net pay owed to employees.'),
  ('payroll_clearing',   '2180', 'Payroll Clearing',   'liability', 'payroll_clearing',     '2100', 'Suspense liability used to balance multi-step payroll postings.')
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.account_role_eligibility (role_key, account_type, detail_type, priority)
VALUES
  ('salary_expense',     'expense',   'payroll_wage_expense',       1),
  ('salary_expense',     'expense',   'payroll_expense',            2),
  ('salary_expense',     'expense',   'payroll_tax_expense',        3),
  ('net_salary_payable', 'liability', 'payroll_clearing',           1),
  ('net_salary_payable', 'liability', 'other_current_liabilities',  2),
  ('payroll_clearing',   'liability', 'payroll_clearing',           1),
  ('payroll_clearing',   'liability', 'other_current_liabilities',  2)
ON CONFLICT (role_key, account_type, detail_type) DO NOTHING;

-- 2. Dedupe default_chart_of_accounts by account_code (neutral rows).
--    Some rows were mis-seeded with country-specific names (BTW, IVA, TVA, ...)
--    but is_country_neutral=true; collapse them down to one canonical English-named
--    row per code, preferring (has role_key, has detail_type, ASCII-only name).
--    The FK accounts.template_account_id is ON DELETE SET NULL — safe.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY account_code
           ORDER BY
             (role_key IS NOT NULL) DESC,
             (detail_type IS NOT NULL) DESC,
             (account_name ~ '^[\x20-\x7E]+$') DESC,   -- pure ASCII first
             length(account_name) ASC,                 -- shorter generic names first
             created_at ASC, id ASC
         ) AS rn
  FROM public.default_chart_of_accounts
  WHERE is_country_neutral = true
)
DELETE FROM public.default_chart_of_accounts d
USING ranked r
WHERE d.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_default_coa_neutral_code
  ON public.default_chart_of_accounts (account_code)
  WHERE is_country_neutral = true;

UPDATE public.default_chart_of_accounts
   SET role_key    = 'net_salary_payable',
       detail_type = 'payroll_clearing'
 WHERE account_code = '2170' AND is_country_neutral = true
   AND (role_key IS DISTINCT FROM 'net_salary_payable'
        OR detail_type IS DISTINCT FROM 'payroll_clearing');

UPDATE public.default_chart_of_accounts
   SET role_key    = 'salary_expense',
       detail_type = 'payroll_wage_expense'
 WHERE account_code = '6100' AND is_country_neutral = true
   AND (role_key IS DISTINCT FROM 'salary_expense'
        OR detail_type IS DISTINCT FROM 'payroll_wage_expense');

INSERT INTO public.default_chart_of_accounts
  (account_code, account_name, account_type, parent_code, description, is_country_neutral, role_key, detail_type)
SELECT '2180', 'Payroll Clearing', 'liability', '2100',
       'Suspense liability used to balance multi-step payroll postings.',
       true, 'payroll_clearing', 'payroll_clearing'
WHERE NOT EXISTS (
  SELECT 1 FROM public.default_chart_of_accounts
  WHERE account_code = '2180' AND is_country_neutral = true
);

-- 3. Rewrite the suggester to honour eligibility, drop heuristics
CREATE OR REPLACE FUNCTION public.payroll_gl_readiness(_org_id uuid, _business_id uuid DEFAULT NULL::uuid)
RETURNS TABLE(
  setting_key text, label text, rule_code text, kind text, required_account_type text,
  is_mapped boolean, suggested_account_id uuid, suggested_account_label text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH rules AS (
    SELECT psr.rule_code, psr.rule_name, n.needs_employee, n.needs_employer
    FROM public.payroll_statutory_rules psr,
         LATERAL public._payroll_rule_needs(psr) n
    WHERE psr.organization_id = _org_id
      AND psr.is_active = true
      AND (psr.effective_to IS NULL OR psr.effective_to >= CURRENT_DATE)
  ),
  needed AS (
    SELECT 'salary_expense'::text     AS setting_key, 'Salary Expense'::text     AS label,
           NULL::text AS rule_code, 'core'::text AS kind, 'expense'::text AS required_account_type,
           'salary_expense'::text AS role_key
    UNION ALL
    SELECT 'net_salary_payable', 'Net Salary Payable',
           NULL, 'core', 'liability', 'net_salary_payable'
    UNION ALL
    SELECT r.rule_code || '_payable', COALESCE(r.rule_name, r.rule_code) || ' — Payable',
           r.rule_code, 'employee_payable', 'liability',
           (SELECT sar.role_key FROM public.system_account_roles sar
             WHERE sar.role_key = lower(r.rule_code) || '_payable' LIMIT 1)
    FROM rules r WHERE r.needs_employee
    UNION ALL
    SELECT r.rule_code || '_employer_expense', COALESCE(r.rule_name, r.rule_code) || ' — Employer Expense',
           r.rule_code, 'employer_expense', 'expense',
           (SELECT sar.role_key FROM public.system_account_roles sar
             WHERE sar.role_key = 'employer_' || lower(r.rule_code) || '_expense' LIMIT 1)
    FROM rules r WHERE r.needs_employer
    UNION ALL
    SELECT r.rule_code || '_payable', COALESCE(r.rule_name, r.rule_code) || ' — Payable',
           r.rule_code, 'employer_payable', 'liability',
           (SELECT sar.role_key FROM public.system_account_roles sar
             WHERE sar.role_key = lower(r.rule_code) || '_payable' LIMIT 1)
    FROM rules r WHERE r.needs_employer AND NOT r.needs_employee
  ),
  needed_dedup AS (
    SELECT DISTINCT ON (setting_key) setting_key, label, rule_code, kind, required_account_type, role_key
    FROM needed
    ORDER BY setting_key,
      CASE kind WHEN 'core' THEN 0 WHEN 'employee_payable' THEN 1
                WHEN 'employer_expense' THEN 2 ELSE 3 END
  ),
  effective_mappings AS (
    SELECT DISTINCT ON (das.setting_key) das.setting_key, das.account_id
    FROM public.default_account_settings das
    WHERE das.organization_id = _org_id
      AND (_business_id IS NULL OR das.business_id IS NULL OR das.business_id = _business_id)
    ORDER BY das.setting_key, (das.business_id IS NOT NULL) DESC
  ),
  candidates AS (
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type, a.detail_type, a.system_role
    FROM public.accounts a
    WHERE a.organization_id = _org_id
      AND COALESCE(a.is_active, true) = true
      AND COALESCE(a.is_header, false) = false
      AND NOT EXISTS (SELECT 1 FROM public.accounts c WHERE c.parent_id = a.id)
      AND (_business_id IS NULL OR a.business_id IS NULL OR a.business_id = _business_id)
  ),
  eligible AS (
    SELECT n.setting_key, c.id AS account_id, c.code, c.name,
           e.priority AS score,
           CASE WHEN c.system_role = n.role_key THEN 0 ELSE 1 END AS role_anchor
    FROM needed_dedup n
    JOIN candidates c ON c.account_type = n.required_account_type
    JOIN public.account_role_eligibility e
      ON e.role_key = n.role_key
     AND e.account_type::text = c.account_type
     AND e.detail_type = c.detail_type
    WHERE n.role_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.payroll_account_role_policy p
        WHERE n.setting_key LIKE p.setting_key_pattern ESCAPE '\'
          AND c.detail_type IS NOT NULL
          AND c.detail_type = ANY (p.denied_detail_types)
      )
      AND NOT (
        (n.setting_key = 'salary_expense' OR n.kind = 'employer_expense')
        AND public._payroll_is_cogs_account(c.id)
      )
    UNION ALL
    SELECT n.setting_key, c.id, c.code, c.name, 1 AS score, 0 AS role_anchor
    FROM needed_dedup n
    JOIN candidates c
      ON c.account_type = n.required_account_type
     AND c.system_role IS NOT NULL
     AND c.system_role = (
       CASE WHEN n.kind = 'employer_expense'
              THEN 'employer_' || lower(n.rule_code) || '_expense'
            ELSE lower(coalesce(n.rule_code, n.setting_key)) || '_payable'
       END
     )
    WHERE n.role_key IS NULL
  ),
  ranked AS (
    SELECT setting_key, account_id,
           row_number() OVER (PARTITION BY setting_key ORDER BY role_anchor, score, code) AS rn
    FROM eligible
  ),
  suggestions AS (SELECT setting_key, account_id FROM ranked WHERE rn = 1)
  SELECT n.setting_key, n.label, n.rule_code, n.kind, n.required_account_type,
         (em.account_id IS NOT NULL) AS is_mapped,
         CASE WHEN em.account_id IS NULL THEN s.account_id END AS suggested_account_id,
         CASE WHEN em.account_id IS NULL THEN
           (SELECT a.code || ' — ' || a.name FROM public.accounts a WHERE a.id = s.account_id)
         END AS suggested_account_label
  FROM needed_dedup n
  LEFT JOIN effective_mappings em ON em.setting_key = n.setting_key
  LEFT JOIN suggestions s ON s.setting_key = n.setting_key
  ORDER BY n.kind, n.setting_key;
$function$;

GRANT EXECUTE ON FUNCTION public.payroll_gl_readiness(uuid, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.payroll_gl_readiness(uuid, uuid) IS
  'Eligibility-driven payroll account suggester. Joins account_role_eligibility for registered roles; for unregistered keys only offers accounts whose system_role exactly anchors the key. No name/code heuristics, no alphabetical fallback. NULL suggested_account_id when nothing semantically valid exists.';

-- 4. Tighten _payroll_assert_mapping_role with eligibility check
CREATE OR REPLACE FUNCTION public._payroll_assert_mapping_role(
  _setting_key text, _account_id  uuid
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_acct       public.accounts%ROWTYPE;
  v_policy     public.payroll_account_role_policy%ROWTYPE;
  v_has_kids   boolean;
  v_name_lc    text;
  v_role_key   text;
  v_role_has_eligibility boolean;
  v_eligible   boolean;
BEGIN
  IF _setting_key IS NULL OR _account_id IS NULL THEN RETURN; END IF;
  IF _setting_key IN ('accounts_payable','accounts_receivable') THEN RETURN; END IF;

  SELECT * INTO v_acct FROM public.accounts WHERE id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: account % not found', _account_id USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.accounts WHERE parent_id = v_acct.id) INTO v_has_kids;
  IF COALESCE(v_acct.is_header, false) OR v_has_kids THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot map to a header / parent account (% — %). Pick a leaf account.',
      _setting_key, v_acct.code, v_acct.name USING ERRCODE = '22023';
  END IF;

  FOR v_policy IN
    SELECT * FROM public.payroll_account_role_policy p
    WHERE _setting_key LIKE p.setting_key_pattern ESCAPE '\'
  LOOP
    IF NOT (v_acct.account_type::text = ANY (v_policy.allowed_account_types)) THEN
      RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires account_type in %, got % (%)',
        _setting_key, v_policy.allowed_account_types, v_acct.account_type, v_acct.code USING ERRCODE = '22023';
    END IF;
    IF v_acct.detail_type IS NOT NULL AND v_acct.detail_type = ANY (v_policy.denied_detail_types) THEN
      RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot map to detail_type % (account %). Pick a dedicated payroll account instead of generic AP.',
        _setting_key, v_acct.detail_type, v_acct.code USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\') THEN
    v_name_lc := lower(COALESCE(v_acct.name, ''));
    IF public._payroll_is_cogs_account(_account_id)
       OR v_name_lc LIKE 'cost of sales%' OR v_name_lc LIKE 'cost of goods sold%' OR v_acct.code = '5000'
    THEN
      RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot map to a Cost of Goods Sold / Cost of Sales account (% — %). Use a payroll/operating expense.',
        _setting_key, v_acct.code, v_acct.name USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Positive eligibility check via account_role_eligibility (NEW).
  v_role_key := CASE
    WHEN EXISTS (SELECT 1 FROM public.system_account_roles WHERE role_key = _setting_key) THEN _setting_key
    ELSE NULL END;
  IF v_role_key IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.account_role_eligibility WHERE role_key = v_role_key) INTO v_role_has_eligibility;
    IF v_role_has_eligibility THEN
      SELECT EXISTS (
        SELECT 1 FROM public.account_role_eligibility e
        WHERE e.role_key = v_role_key
          AND e.account_type::text = v_acct.account_type::text
          AND e.detail_type = v_acct.detail_type
      ) INTO v_eligible;
      IF NOT v_eligible THEN
        RAISE EXCEPTION 'payroll_mapping_role_violation: account %/% (detail_type=%) is not eligible for role %. Pick an account whose detail type matches the role.',
          v_acct.code, v_acct.name, COALESCE(v_acct.detail_type, '<null>'), v_role_key USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;
END;
$function$;

-- 5. payroll_create_and_map_account: route registered role keys via upsert_system_account with canonical detail_type
CREATE OR REPLACE FUNCTION public.payroll_create_and_map_account(
  _org_id uuid, _business_id uuid, _setting_key text, _name text,
  _account_type text, _code text DEFAULT NULL::text, _branch_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_account_id uuid;
  v_existing_mapped_id uuid;
  v_existing_code_id uuid;
  v_code text;
  v_prefix text;
  v_lname text := lower(coalesce(_name, ''));
  v_is_role boolean := false;
  v_detail_type text;
  v_lock_key bigint;
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user AND ur.organization_id = _org_id AND ur.is_active = true
    ) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  END IF;

  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\')
     AND lower(_account_type) <> 'expense' THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires _account_type=expense', _setting_key USING ERRCODE = '22023';
  END IF;
  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\')
     AND (v_lname ~ '(cost of goods sold|cost of sales|cost of revenue|cogs)') THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot create a COGS-flavoured account (%)', _setting_key, _name USING ERRCODE = '22023';
  END IF;
  IF (_setting_key LIKE '%\_payable' ESCAPE '\' OR _setting_key = 'net_salary_payable')
     AND lower(_account_type) <> 'liability' THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires _account_type=liability', _setting_key USING ERRCODE = '22023';
  END IF;

  v_lock_key := hashtextextended(_business_id::text || '|' || _setting_key, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT EXISTS (SELECT 1 FROM public.system_account_roles WHERE role_key = _setting_key) INTO v_is_role;

  IF v_is_role THEN
    SELECT suggested_code INTO v_code
      FROM public.system_account_template
     WHERE role_key = _setting_key AND account_type::text = lower(_account_type)
     LIMIT 1;
  END IF;

  IF v_code IS NULL THEN
    v_prefix := CASE lower(_account_type)
      WHEN 'expense' THEN '6900' WHEN 'liability' THEN '2300'
      WHEN 'asset' THEN '1900' WHEN 'income' THEN '4900'
      WHEN 'equity' THEN '3900' ELSE '9000'
    END;
    v_code := COALESCE(_code, v_prefix || '-' || upper(left(regexp_replace(_setting_key, '[^a-zA-Z0-9]', '', 'g'), 10)));
  END IF;

  IF v_is_role THEN
    v_detail_type := public._resolve_account_detail_type(_setting_key, lower(_account_type), NULL);
    v_account_id := public.upsert_system_account(
      _org_id, _business_id, _setting_key,
      lower(_account_type), v_detail_type,
      v_code, _name, NULL, NULL, false
    );
  ELSE
    SELECT account_id INTO v_existing_mapped_id
      FROM public.default_account_settings
     WHERE organization_id = _org_id
       AND (business_id IS NULL OR business_id = _business_id)
       AND setting_key = _setting_key
     LIMIT 1;
    IF v_existing_mapped_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.accounts WHERE id = v_existing_mapped_id AND is_active = true) THEN
      v_account_id := v_existing_mapped_id;
    ELSE
      SELECT id INTO v_existing_code_id
        FROM public.accounts
       WHERE organization_id = _org_id
         AND (business_id IS NULL OR business_id = _business_id)
         AND code = v_code
       LIMIT 1;
      IF v_existing_code_id IS NOT NULL THEN
        v_account_id := v_existing_code_id;
      ELSE
        INSERT INTO public.accounts (organization_id, business_id, code, name, account_type, is_active, is_header)
        VALUES (_org_id, _business_id, v_code, _name, _account_type::public.account_type_enum, true, false)
        RETURNING id INTO v_account_id;
      END IF;
    END IF;
  END IF;

  PERFORM public._payroll_assert_mapping_role(_setting_key, v_account_id);
  PERFORM public._upsert_default_account_setting(_org_id, _business_id, _branch_id, _setting_key, v_account_id);
  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_account_id;
END;
$function$;

-- 6. Repair function for legacy NSSF/SHIF duplicate-employer accounts
CREATE OR REPLACE FUNCTION public.repair_payroll_duplicate_accounts(
  _business_id uuid, _dry_run boolean DEFAULT true
)
RETURNS TABLE(role_key text, kept_account_id uuid, kept_code text, merged_account_id uuid, merged_code text, je_lines_repointed integer, mappings_repointed integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid; r RECORD; v_keep uuid; v_keep_code text;
  v_merged_lines integer; v_merged_maps integer;
BEGIN
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = _business_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'business % not found', _business_id USING ERRCODE = 'P0002'; END IF;

  FOR r IN
    SELECT a.system_role, a.id, a.code, a.name
    FROM public.accounts a
    WHERE a.business_id = _business_id AND a.organization_id = v_org
      AND COALESCE(a.is_active, true) = true
      AND (lower(a.name) ~ '(nssf|shif).*(employer|contribution)'
        OR lower(a.name) ~ '(employer|er) (nssf|shif)')
    ORDER BY a.code
  LOOP
    SELECT a.id, a.code INTO v_keep, v_keep_code
      FROM public.accounts a
     WHERE a.business_id = _business_id AND COALESCE(a.is_active, true) = true
       AND (lower(a.name) ~ (CASE WHEN lower(r.name) ~ 'nssf' THEN 'nssf' ELSE 'shif' END))
     ORDER BY (a.system_role IS NOT NULL) DESC, a.code ASC
     LIMIT 1;
    IF v_keep IS NULL OR r.id = v_keep THEN CONTINUE; END IF;

    v_merged_lines := 0; v_merged_maps := 0;
    IF NOT _dry_run THEN
      WITH upd AS (UPDATE public.journal_entry_lines SET account_id = v_keep WHERE account_id = r.id RETURNING 1)
      SELECT count(*) INTO v_merged_lines FROM upd;
      WITH upd AS (UPDATE public.default_account_settings SET account_id = v_keep, updated_at = now() WHERE account_id = r.id RETURNING 1)
      SELECT count(*) INTO v_merged_maps FROM upd;
      UPDATE public.accounts SET is_active = false, updated_at = now() WHERE id = r.id;
    ELSE
      SELECT count(*) INTO v_merged_lines FROM public.journal_entry_lines WHERE account_id = r.id;
      SELECT count(*) INTO v_merged_maps  FROM public.default_account_settings WHERE account_id = r.id;
    END IF;

    role_key := COALESCE(r.system_role, 'unmapped');
    kept_account_id := v_keep; kept_code := v_keep_code;
    merged_account_id := r.id; merged_code := r.code;
    je_lines_repointed := v_merged_lines; mappings_repointed := v_merged_maps;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.repair_payroll_duplicate_accounts(uuid, boolean) TO authenticated, service_role;
COMMENT ON FUNCTION public.repair_payroll_duplicate_accounts(uuid, boolean) IS
  'Finds duplicate NSSF/SHIF employer accounts on a business, keeps the registry-anchored canonical one, re-points JE lines and default_account_settings, archives the rest. Pass _dry_run=true (default) to preview.';

-- 7. Backfill the live tenant
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id AS business_id, organization_id FROM public.businesses LOOP
    BEGIN
      PERFORM public.upsert_system_account(r.organization_id, r.business_id, 'salary_expense',
        'expense', 'payroll_wage_expense',
        '6100', 'Salaries & Wages', 'Gross salaries & wages booked from payroll.', NULL, false);
      PERFORM public.upsert_system_account(r.organization_id, r.business_id, 'net_salary_payable',
        'liability', 'payroll_clearing',
        '2170', 'Net Salary Payable', 'Net pay owed to employees.', NULL, false);
      PERFORM public.upsert_system_account(r.organization_id, r.business_id, 'payroll_clearing',
        'liability', 'payroll_clearing',
        '2180', 'Payroll Clearing', 'Suspense liability used to balance multi-step payroll postings.', NULL, false);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'payroll role backfill skipped for business %: %', r.business_id, SQLERRM;
    END;
  END LOOP;
END $$;
