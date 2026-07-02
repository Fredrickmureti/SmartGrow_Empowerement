
-- ============================================================
-- A.1 / A.2 — Trigger & assertion: exclude generic AP/AR keys,
-- reject header / parent accounts, tighten COGS detection.
-- ============================================================

CREATE OR REPLACE FUNCTION public._payroll_default_account_role_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.setting_key IS NULL OR NEW.account_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.setting_key IN ('accounts_payable','accounts_receivable') THEN
    RETURN NEW;
  END IF;

  IF NEW.setting_key = 'salary_expense'
     OR NEW.setting_key LIKE '%\_payable' ESCAPE '\'
     OR NEW.setting_key LIKE '%\_employer\_expense' ESCAPE '\'
  THEN
    PERFORM public._payroll_assert_mapping_role(NEW.setting_key, NEW.account_id);
  END IF;

  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public._payroll_assert_mapping_role(
  _setting_key text,
  _account_id  uuid
) RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_acct       public.accounts%ROWTYPE;
  v_policy     public.payroll_account_role_policy%ROWTYPE;
  v_matched    boolean := false;
  v_has_kids   boolean;
  v_name_lc    text;
BEGIN
  IF _setting_key IS NULL OR _account_id IS NULL THEN RETURN; END IF;

  IF _setting_key IN ('accounts_payable','accounts_receivable') THEN RETURN; END IF;

  SELECT * INTO v_acct FROM public.accounts WHERE id = _account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: account % not found', _account_id
      USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.accounts WHERE parent_id = v_acct.id) INTO v_has_kids;
  IF COALESCE(v_acct.is_header, false) OR v_has_kids THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot map to a header / parent account (% — %). Pick a leaf account.',
      _setting_key, v_acct.code, v_acct.name
      USING ERRCODE = '22023';
  END IF;

  FOR v_policy IN
    SELECT *
    FROM public.payroll_account_role_policy p
    WHERE _setting_key LIKE p.setting_key_pattern ESCAPE '\'
  LOOP
    v_matched := true;

    IF NOT (v_acct.account_type::text = ANY (v_policy.allowed_account_types)) THEN
      RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires account_type in %, got % (%)',
        _setting_key, v_policy.allowed_account_types, v_acct.account_type, v_acct.code
        USING ERRCODE = '22023';
    END IF;

    IF v_acct.detail_type IS NOT NULL
       AND v_acct.detail_type = ANY (v_policy.denied_detail_types) THEN
      RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot map to detail_type % (account %). Pick a dedicated payroll account instead of generic AP.',
        _setting_key, v_acct.detail_type, v_acct.code
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF (_setting_key = 'salary_expense' OR _setting_key LIKE '%\_employer\_expense' ESCAPE '\') THEN
    v_name_lc := lower(COALESCE(v_acct.name, ''));
    IF public._payroll_is_cogs_account(_account_id)
       OR v_name_lc LIKE 'cost of sales%'
       OR v_name_lc LIKE 'cost of goods sold%'
       OR v_acct.code = '5000'
    THEN
      RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % cannot map to a Cost of Goods Sold / Cost of Sales account (% — %). Use a payroll/operating expense.',
        _setting_key, v_acct.code, v_acct.name
        USING ERRCODE = '22023';
    END IF;
  END IF;
END;
$function$;


-- ============================================================
-- A.3 — Backfill is_header on parents. Clear detail_type first
-- because the existing enforce_header_no_detail_type trigger
-- rejects headers that still carry a detail_type.
-- ============================================================
WITH parents AS (
  SELECT DISTINCT a.id
  FROM public.accounts a
  JOIN public.accounts c ON c.parent_id = a.id
  WHERE COALESCE(a.is_header, false) = false
)
UPDATE public.accounts a
   SET detail_type = NULL
  FROM parents p
 WHERE a.id = p.id
   AND a.detail_type IS NOT NULL;

UPDATE public.accounts a
   SET is_header = true
 WHERE EXISTS (SELECT 1 FROM public.accounts c WHERE c.parent_id = a.id)
   AND COALESCE(a.is_header, false) = false;


-- ============================================================
-- D — Strip clearly wrong AR detail_type on PPE-style seed rows
-- with zero journal activity.
-- ============================================================
UPDATE public.accounts
   SET detail_type = NULL
 WHERE detail_type = 'accounts_receivable'
   AND account_type = 'asset'
   AND (
        name ILIKE 'non-current%'
     OR name ILIKE 'property%'
     OR name ILIKE 'land and buildings%'
     OR name ILIKE 'motor vehicles%'
     OR name ILIKE 'furniture%'
     OR name ILIKE 'computer equipment%'
     OR name ILIKE 'accumulated depreciation%'
   )
   AND NOT EXISTS (
     SELECT 1 FROM public.journal_entry_lines jel WHERE jel.account_id = accounts.id
   );


-- ============================================================
-- B.4 — Add employer-contribution expense templates to Kenya pack.
-- ============================================================
INSERT INTO public.localization_pack_account_templates
  (pack_id, code, name, account_type, parent_code, description, sort_order)
SELECT lp.id, t.code, t.name, t.account_type::text, t.parent_code, t.description, t.sort_order
FROM public.localization_packs lp
CROSS JOIN (VALUES
  ('6151','NSSF Employer Contribution','expense','6150','Employer 6% NSSF contribution expense (separate from employee deduction).',151),
  ('6152','AHL Employer Contribution','expense','6150','Employer 1.5% Affordable Housing Levy contribution expense.',152),
  ('6153','NITA Employer Contribution','expense','6150','Employer NITA levy expense (KES 50/employee/month).',153)
) AS t(code, name, account_type, parent_code, description, sort_order)
WHERE lp.country_code = 'KE'
  AND NOT EXISTS (
    SELECT 1 FROM public.localization_pack_account_templates x
    WHERE x.pack_id = lp.id AND x.code = t.code
  );


-- ============================================================
-- B.4 backfill — create accounts on every tenant that has 6150.
-- ============================================================
DO $$
DECLARE
  r RECORD;
  v_parent uuid;
  v_code text;
  v_name text;
  v_desc text;
BEGIN
  FOR r IN
    SELECT DISTINCT organization_id, business_id
    FROM public.accounts
    WHERE code = '6150' AND name ILIKE 'Payroll: Employer Contributions%'
  LOOP
    SELECT id INTO v_parent
    FROM public.accounts
    WHERE organization_id = r.organization_id
      AND (business_id IS NOT DISTINCT FROM r.business_id)
      AND code = '6150'
    LIMIT 1;
    IF v_parent IS NULL THEN CONTINUE; END IF;

    -- Promote parent to header (and strip detail_type) before adding children.
    UPDATE public.accounts SET detail_type = NULL WHERE id = v_parent AND detail_type IS NOT NULL;
    UPDATE public.accounts SET is_header = true WHERE id = v_parent AND COALESCE(is_header,false)=false;

    FOR v_code, v_name, v_desc IN
      SELECT * FROM (VALUES
        ('6151','NSSF Employer Contribution','Employer 6% NSSF contribution expense.'),
        ('6152','AHL Employer Contribution','Employer 1.5% Affordable Housing Levy contribution expense.'),
        ('6153','NITA Employer Contribution','Employer NITA levy expense (KES 50/employee/month).')
      ) AS v(code,name,description)
    LOOP
      INSERT INTO public.accounts
        (organization_id, business_id, code, name, account_type, parent_id, description, is_system, is_active, detail_type)
      SELECT r.organization_id, r.business_id, v_code, v_name, 'expense', v_parent, v_desc, true, true, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM public.accounts
        WHERE organization_id = r.organization_id
          AND (business_id IS NOT DISTINCT FROM r.business_id)
          AND code = v_code
      );
    END LOOP;
  END LOOP;
END $$;


-- ============================================================
-- B.5 — Better suggester (leaf-only, COGS-aware, statute-token).
-- ============================================================
CREATE OR REPLACE FUNCTION public.payroll_gl_readiness(_org_id uuid, _business_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(setting_key text, label text, rule_code text, kind text, required_account_type text, is_mapped boolean, suggested_account_id uuid, suggested_account_label text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH rules AS (
    SELECT psr.rule_code, psr.rule_name, psr.rule_type, psr.parameters,
           n.needs_employee, n.needs_employer
    FROM public.payroll_statutory_rules psr,
         LATERAL public._payroll_rule_needs(psr) n
    WHERE psr.organization_id = _org_id
      AND psr.is_active = true
      AND (psr.effective_to IS NULL OR psr.effective_to >= CURRENT_DATE)
  ),
  needed AS (
    SELECT 'salary_expense'::text AS setting_key, 'Salary Expense'::text AS label,
           NULL::text AS rule_code, 'core'::text AS kind, 'expense'::text AS required_account_type
    UNION ALL
    SELECT 'net_salary_payable', 'Net Salary Payable', NULL, 'core', 'liability'
    UNION ALL
    SELECT r.rule_code || '_payable', COALESCE(r.rule_name, r.rule_code) || ' — Payable',
           r.rule_code, 'employee_payable', 'liability'
    FROM rules r WHERE r.needs_employee
    UNION ALL
    SELECT r.rule_code || '_employer_expense', COALESCE(r.rule_name, r.rule_code) || ' — Employer Expense',
           r.rule_code, 'employer_expense', 'expense'
    FROM rules r WHERE r.needs_employer
    UNION ALL
    SELECT r.rule_code || '_payable', COALESCE(r.rule_name, r.rule_code) || ' — Payable',
           r.rule_code, 'employer_payable', 'liability'
    FROM rules r WHERE r.needs_employer AND NOT r.needs_employee
  ),
  needed_dedup AS (
    SELECT DISTINCT ON (setting_key) setting_key, label, rule_code, kind, required_account_type
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
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type, a.detail_type
    FROM public.accounts a
    WHERE a.organization_id = _org_id
      AND COALESCE(a.is_active, true) = true
      AND COALESCE(a.is_header, false) = false
      AND NOT EXISTS (SELECT 1 FROM public.accounts c WHERE c.parent_id = a.id)
      AND (_business_id IS NULL OR a.business_id IS NULL OR a.business_id = _business_id)
  ),
  valid_candidates AS (
    SELECT n.setting_key, n.rule_code, n.kind, c.id AS account_id, c.code, c.name, c.detail_type
    FROM needed_dedup n
    JOIN candidates c ON c.account_type = n.required_account_type
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.payroll_account_role_policy p
      WHERE n.setting_key LIKE p.setting_key_pattern ESCAPE '\'
        AND (
          NOT (c.account_type = ANY (p.allowed_account_types))
          OR (c.detail_type IS NOT NULL AND c.detail_type = ANY (p.denied_detail_types))
        )
    )
    AND NOT (
      (n.setting_key = 'salary_expense' OR n.kind = 'employer_expense')
      AND (
        public._payroll_is_cogs_account(c.id)
        OR lower(c.name) LIKE 'cost of sales%'
        OR lower(c.name) LIKE 'cost of goods sold%'
        OR c.code = '5000'
      )
    )
  ),
  ranked AS (
    SELECT v.setting_key, v.account_id,
      ROW_NUMBER() OVER (
        PARTITION BY v.setting_key
        ORDER BY
          CASE
            WHEN v.setting_key LIKE 'paye%'                  AND v.code = '2022' THEN 0
            WHEN v.setting_key LIKE 'nssf%'                  AND v.code = '2031' AND v.kind <> 'employer_expense' THEN 0
            WHEN v.setting_key LIKE 'shif%'                  AND v.code = '2032' THEN 0
            WHEN (v.setting_key LIKE 'affordable_housing%' OR v.setting_key LIKE 'ahl%' OR v.setting_key LIKE 'housing%')
                                                              AND v.code = '2033' AND v.kind <> 'employer_expense' THEN 0
            WHEN v.setting_key LIKE 'nita%'                  AND v.code = '2034' AND v.kind <> 'employer_expense' THEN 0
            WHEN v.kind = 'employer_expense' AND v.setting_key LIKE 'nssf%' AND v.code = '6151' THEN 0
            WHEN v.kind = 'employer_expense' AND (v.setting_key LIKE 'affordable_housing%' OR v.setting_key LIKE 'ahl%' OR v.setting_key LIKE 'housing%') AND v.code = '6152' THEN 0
            WHEN v.kind = 'employer_expense' AND v.setting_key LIKE 'nita%' AND v.code = '6153' THEN 0
            WHEN v.setting_key = 'salary_expense' AND v.code = '6100' THEN 0
            WHEN v.setting_key = 'net_salary_payable' AND v.code = '2170' THEN 0
            WHEN v.setting_key LIKE 'nssf%' AND lower(v.name) LIKE '%nssf%' THEN 1
            WHEN v.setting_key LIKE 'shif%' AND lower(v.name) LIKE '%shif%' THEN 1
            WHEN v.setting_key LIKE 'paye%' AND lower(v.name) LIKE '%paye%' THEN 1
            WHEN v.setting_key LIKE 'nita%' AND lower(v.name) LIKE '%nita%' THEN 1
            WHEN (v.setting_key LIKE 'affordable_housing%' OR v.setting_key LIKE 'ahl%' OR v.setting_key LIKE 'housing%')
                  AND lower(v.name) LIKE '%housing%' THEN 1
            ELSE 9
          END,
          v.code
      ) AS rn
    FROM valid_candidates v
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


-- ============================================================
-- C — Repoint existing mis-mapped tenants.
-- ============================================================
DO $$
DECLARE
  r RECORD;
  v_target uuid;
  v_target_code text;
BEGIN
  FOR r IN
    SELECT das.id, das.organization_id, das.business_id, das.setting_key, a.code AS cur_code, a.name AS cur_name
    FROM public.default_account_settings das
    JOIN public.accounts a ON a.id = das.account_id
    WHERE
      (das.setting_key LIKE '%\_payable' ESCAPE '\'
        AND das.setting_key NOT IN ('accounts_payable','accounts_receivable')
        AND (a.code IN ('2000','2010','2030')
             OR COALESCE(a.is_header,false) = true
             OR EXISTS (SELECT 1 FROM public.accounts c WHERE c.parent_id = a.id)))
      OR
      (das.setting_key LIKE '%\_employer\_expense' ESCAPE '\'
        AND (a.code = '5000' OR lower(a.name) LIKE 'cost of sales%' OR lower(a.name) LIKE 'cost of goods sold%'))
      OR
      (das.setting_key = 'salary_expense'
        AND (a.code = '5000' OR lower(a.name) LIKE 'cost of sales%' OR lower(a.name) LIKE 'cost of goods sold%'))
  LOOP
    v_target_code := CASE
      WHEN r.setting_key LIKE 'paye%'                                                       AND r.setting_key LIKE '%_payable'          THEN '2022'
      WHEN r.setting_key LIKE 'nssf%'                                                       AND r.setting_key LIKE '%_payable'          THEN '2031'
      WHEN r.setting_key LIKE 'shif%'                                                       AND r.setting_key LIKE '%_payable'          THEN '2032'
      WHEN (r.setting_key LIKE 'affordable_housing%' OR r.setting_key LIKE 'ahl%' OR r.setting_key LIKE 'housing%') AND r.setting_key LIKE '%_payable' THEN '2033'
      WHEN r.setting_key LIKE 'nita%'                                                       AND r.setting_key LIKE '%_payable'          THEN '2034'
      WHEN r.setting_key LIKE 'nssf%'                                                       AND r.setting_key LIKE '%_employer_expense' THEN '6151'
      WHEN (r.setting_key LIKE 'affordable_housing%' OR r.setting_key LIKE 'ahl%' OR r.setting_key LIKE 'housing%') AND r.setting_key LIKE '%_employer_expense' THEN '6152'
      WHEN r.setting_key LIKE 'nita%'                                                       AND r.setting_key LIKE '%_employer_expense' THEN '6153'
      WHEN r.setting_key = 'salary_expense'                                                                                             THEN '6100'
      ELSE NULL
    END;

    IF v_target_code IS NULL THEN CONTINUE; END IF;

    SELECT a.id INTO v_target
    FROM public.accounts a
    WHERE a.organization_id = r.organization_id
      AND (a.business_id IS NOT DISTINCT FROM r.business_id OR a.business_id IS NULL)
      AND COALESCE(a.is_active,true)=true
      AND a.code = v_target_code
    ORDER BY (a.business_id IS NOT NULL) DESC
    LIMIT 1;

    IF v_target IS NOT NULL THEN
      UPDATE public.default_account_settings
         SET account_id = v_target, updated_at = now()
       WHERE id = r.id AND account_id IS DISTINCT FROM v_target;
    END IF;
  END LOOP;
END $$;


-- ============================================================
-- Refresh setup status.
-- ============================================================
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT organization_id, business_id FROM public.default_account_settings LOOP
    BEGIN
      PERFORM public.refresh_payroll_setup_status(r.organization_id, r.business_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;


COMMENT ON FUNCTION public._payroll_assert_mapping_role(text, uuid) IS
  'Phase-3+: generic accounts_payable/accounts_receivable keys are exempt. Header/parent accounts (declared or implied by children) are rejected. salary_expense / *_employer_expense cannot map to a Cost of Sales / Cost of Goods Sold account regardless of detail_type.';
