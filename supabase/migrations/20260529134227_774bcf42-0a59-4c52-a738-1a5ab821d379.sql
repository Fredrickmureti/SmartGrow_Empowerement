-- =====================================================================
-- Phase 2a — Canonical detail_type resolution for role-bearing accounts
-- =====================================================================

-- 1. Register pan-African statutory payroll roles.
INSERT INTO public.system_account_roles
  (role_key, label, description, required_account_type, is_mandatory, category, sort_order)
VALUES
  ('paye_payable',                'PAYE Payable',
   'Employee income tax withheld at source, payable to the tax authority (KRA, URA, TRA, SARS, etc.).',
   'liability', false, 'payroll', 600),
  ('nssf_payable',                'NSSF Payable',
   'National Social Security Fund contributions payable (employee + employer share where applicable).',
   'liability', false, 'payroll', 610),
  ('shif_payable',                'SHIF Payable',
   'Social Health Insurance Fund contributions payable (Kenya, replaces NHIF Oct 2024).',
   'liability', false, 'payroll', 620),
  ('nhif_payable',                'NHIF Payable',
   'Legacy National Hospital Insurance Fund contributions payable (Kenya, pre-Oct 2024).',
   'liability', false, 'payroll', 625),
  ('housing_levy_payable',        'Housing Levy Payable',
   'Affordable Housing Levy contributions payable.',
   'liability', false, 'payroll', 630),
  ('employer_nssf_expense',       'Employer NSSF Expense',
   'Employer share of NSSF contributions.',
   'expense',   false, 'payroll', 640),
  ('employer_shif_expense',       'Employer SHIF Expense',
   'Employer share of SHIF contributions.',
   'expense',   false, 'payroll', 650),
  ('employer_nhif_expense',       'Employer NHIF Expense',
   'Legacy employer NHIF expense (Kenya, pre-Oct 2024).',
   'expense',   false, 'payroll', 655),
  ('employer_housing_levy_expense','Employer Housing Levy Expense',
   'Employer share of Affordable Housing Levy.',
   'expense',   false, 'payroll', 660)
ON CONFLICT (role_key) DO NOTHING;


-- 2. Curated template rows. Covers the new statutory roles AND backfills
--    the four pre-existing roles that had no template
--    (inventory_shrinkage_expense, inventory_overage_income,
--    inventory_revaluation, grni). system_account_template is the single
--    source of truth for canonical detail_type — every role MUST appear.
INSERT INTO public.system_account_template
  (role_key, suggested_code, suggested_name, account_type, detail_type, parent_code_hint, description)
VALUES
  -- statutory payroll (this migration)
  ('paye_payable',                 '2022', 'PAYE Payable',                'liability', 'payroll_tax_payable', '2020',
   'Employee income tax withheld at source, payable to the tax authority.'),
  ('nssf_payable',                 '2031', 'NSSF Payable',                'liability', 'payroll_tax_payable', '2030',
   'National Social Security Fund contributions payable.'),
  ('shif_payable',                 '2032', 'SHIF Payable',                'liability', 'payroll_tax_payable', '2030',
   'Social Health Insurance Fund contributions payable (Kenya).'),
  ('nhif_payable',                 '2030', 'NHIF Payable',                'liability', 'payroll_tax_payable', '2030',
   'Legacy NHIF contributions payable (Kenya, pre-Oct 2024).'),
  ('housing_levy_payable',         '2033', 'Housing Levy Payable',        'liability', 'payroll_tax_payable', '2030',
   'Affordable Housing Levy contributions payable.'),
  ('employer_nssf_expense',        '6011', 'Employer NSSF Contribution',  'expense',   'payroll_tax_expense', '6000',
   'Employer share of NSSF contributions.'),
  ('employer_shif_expense',        '6012', 'Employer SHIF Contribution',  'expense',   'payroll_tax_expense', '6000',
   'Employer share of SHIF contributions.'),
  ('employer_nhif_expense',        '6010', 'Employer NHIF Contribution',  'expense',   'payroll_tax_expense', '6000',
   'Legacy employer NHIF contribution.'),
  ('employer_housing_levy_expense','6013', 'Employer Housing Levy',       'expense',   'payroll_tax_expense', '6000',
   'Employer share of Affordable Housing Levy.'),
  -- pre-existing orphans (backfill so the invariant in step 8 holds)
  ('inventory_shrinkage_expense',  '5150', 'Inventory Shrinkage',         'expense',   'other_business_expenses', '7000',
   'Stock shrinkage / write-off expense.'),
  ('inventory_overage_income',     '4910', 'Inventory Overage / Found Stock','income','other_business_income',   '4200',
   'Inventory overage / found-stock income.'),
  ('inventory_revaluation',        '5160', 'Inventory Revaluation',       'expense',   'other_business_expenses', '7000',
   'Inventory revaluation P&L impact (defaults to inventory adjustments account).'),
  ('grni',                         '21100','Goods Received Not Invoiced', 'liability', 'other_current_liabilities','2100',
   'Accrual for inventory received but not yet invoiced (GRNI clearing).')
ON CONFLICT (role_key) DO UPDATE SET
  suggested_code   = EXCLUDED.suggested_code,
  suggested_name   = EXCLUDED.suggested_name,
  account_type     = EXCLUDED.account_type,
  detail_type      = EXCLUDED.detail_type,
  parent_code_hint = EXCLUDED.parent_code_hint,
  description      = EXCLUDED.description;


-- 3. Eligibility rows for the new roles. Without these, mapping an
--    account to one of these roles would fail eligibility check.
INSERT INTO public.account_role_eligibility (role_key, account_type, detail_type, priority) VALUES
  ('paye_payable',                 'liability', 'payroll_tax_payable',          1),
  ('paye_payable',                 'liability', 'other_current_liabilities',    2),
  ('nssf_payable',                 'liability', 'payroll_tax_payable',          1),
  ('nssf_payable',                 'liability', 'other_current_liabilities',    2),
  ('shif_payable',                 'liability', 'payroll_tax_payable',          1),
  ('shif_payable',                 'liability', 'other_current_liabilities',    2),
  ('nhif_payable',                 'liability', 'payroll_tax_payable',          1),
  ('nhif_payable',                 'liability', 'other_current_liabilities',    2),
  ('housing_levy_payable',         'liability', 'payroll_tax_payable',          1),
  ('housing_levy_payable',         'liability', 'other_current_liabilities',    2),
  ('employer_nssf_expense',        'expense',   'payroll_tax_expense',          1),
  ('employer_nssf_expense',        'expense',   'payroll_expense',              2),
  ('employer_nssf_expense',        'expense',   'other_business_expenses',      3),
  ('employer_shif_expense',        'expense',   'payroll_tax_expense',          1),
  ('employer_shif_expense',        'expense',   'payroll_expense',              2),
  ('employer_shif_expense',        'expense',   'other_business_expenses',      3),
  ('employer_nhif_expense',        'expense',   'payroll_tax_expense',          1),
  ('employer_nhif_expense',        'expense',   'payroll_expense',              2),
  ('employer_nhif_expense',        'expense',   'other_business_expenses',      3),
  ('employer_housing_levy_expense','expense',   'payroll_tax_expense',          1),
  ('employer_housing_levy_expense','expense',   'payroll_expense',              2),
  ('employer_housing_levy_expense','expense',   'other_business_expenses',      3),
  ('inventory_shrinkage_expense',  'expense',   'other_business_expenses',      1),
  ('inventory_shrinkage_expense',  'expense',   'cost_of_sales_other',          2),
  ('inventory_shrinkage_expense',  'expense',   'other_expense',                3),
  ('inventory_overage_income',     'income',    'other_business_income',        1),
  ('inventory_overage_income',     'income',    'other_misc_income',            2),
  ('inventory_overage_income',     'income',    'other_income',                 3),
  ('inventory_revaluation',        'expense',   'other_business_expenses',      1),
  ('inventory_revaluation',        'expense',   'cost_of_sales_other',          2),
  ('inventory_revaluation',        'expense',   'other_expense',                3),
  ('grni',                         'liability', 'other_current_liabilities',    1)
ON CONFLICT (role_key, account_type, detail_type) DO NOTHING;


-- 4. Canonical detail_type resolver helper.
CREATE OR REPLACE FUNCTION public._resolve_account_detail_type(
  _role_key             text,
  _account_type         text,
  _supplied_detail_type text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_template_detail text;
  v_norm_type       text := lower(coalesce(_account_type, ''));
BEGIN
  IF v_norm_type = 'revenue' THEN v_norm_type := 'income'; END IF;

  IF _role_key IS NOT NULL THEN
    SELECT t.detail_type INTO v_template_detail
      FROM public.system_account_template t
     WHERE t.role_key = _role_key
       AND t.account_type::text = v_norm_type
     LIMIT 1;
    IF v_template_detail IS NOT NULL THEN
      RETURN v_template_detail;
    END IF;
  END IF;

  IF _supplied_detail_type IS NOT NULL AND _supplied_detail_type <> '' THEN
    RETURN _supplied_detail_type;
  END IF;

  RETURN CASE v_norm_type
    WHEN 'asset'     THEN 'other_current_asset'
    WHEN 'liability' THEN 'other_current_liabilities'
    WHEN 'equity'    THEN 'other_equity'
    WHEN 'income'    THEN 'other_business_income'
    WHEN 'expense'   THEN 'other_business_expenses'
    ELSE NULL
  END;
END;
$function$;

COMMENT ON FUNCTION public._resolve_account_detail_type(text, text, text) IS
  'Canonical detail_type resolver. Order: system_account_template -> caller-supplied -> generic per-account_type fallback. Used by the localization-pack installer so canonical role detail_types cannot drift from the registry.';


-- 5. Backfill the Kenya localization pack's role-bearing template rows.
WITH ke_role_map(code, role_key) AS (
  VALUES
    ('5010', 'cogs'),
    ('2022', 'paye_payable'),
    ('2031', 'nssf_payable'),
    ('2032', 'shif_payable'),
    ('2033', 'housing_levy_payable'),
    ('6011', 'employer_nssf_expense'),
    ('6012', 'employer_shif_expense'),
    ('6013', 'employer_housing_levy_expense')
)
UPDATE public.localization_pack_account_templates t
   SET role_key    = m.role_key,
       detail_type = tmpl.detail_type
  FROM ke_role_map m
  JOIN public.system_account_template tmpl ON tmpl.role_key = m.role_key
 WHERE t.pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid
   AND t.code    = m.code
   AND (t.role_key IS DISTINCT FROM m.role_key
        OR t.detail_type IS DISTINCT FROM tmpl.detail_type);


-- 6. Rewrite install_localization_pack_atomic — identical to Phase 1
--    EXCEPT Pass A and Pass B both route detail_type through the helper.
CREATE OR REPLACE FUNCTION public.install_localization_pack_atomic(
  _business_id uuid, _pack_id uuid, _installed_by uuid, _force_reseed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org_id uuid;
  _pack record;
  _existing record;
  _taxes_seeded int := 0;
  _accounts_seeded int := 0;
  _role_seeded int := 0;
  _payroll_seeded int := 0;
  _payroll_skipped int := 0;
  _step text := 'init';
  _sqlstate text;
  _errmsg text;
  _errdetail text;
  _r record;
  _rid uuid;
  _lock_key bigint;
BEGIN
  _step := 'resolve_business';
  SELECT organization_id INTO _org_id FROM businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id USING ERRCODE = 'P0002';
  END IF;

  _step := 'resolve_pack';
  SELECT * INTO _pack FROM localization_packs
    WHERE id = _pack_id AND is_active = true AND is_published = true;
  IF _pack.id IS NULL THEN
    RAISE EXCEPTION 'Localization pack % not found or not published', _pack_id USING ERRCODE = 'P0002';
  END IF;

  _lock_key := hashtextextended(_business_id::text || '|' || _pack_id::text, 0);
  PERFORM pg_advisory_xact_lock(_lock_key);

  _step := 'check_existing';
  SELECT * INTO _existing FROM installed_localization_packs
    WHERE business_id = _business_id AND pack_id = _pack_id;

  IF _existing.id IS NOT NULL AND NOT _force_reseed THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_installed', true,
      'status', 'installed',
      'message', format('Pack "%s" is already installed (v%s). Use force_reseed=true to re-apply.',
                        _pack.name, _existing.pack_version)
    );
  END IF;

  _step := 'seed_tax_rates';
  WITH inserted AS (
    INSERT INTO tax_rates (
      organization_id, business_id, name, rate, description,
      is_compound, is_inclusive, is_default, is_active,
      tax_type, fixed_amount, effective_from
    )
    SELECT
      _org_id, _business_id, t.name, t.rate, t.description,
      t.is_compound, t.is_inclusive, t.is_default, true,
      COALESCE(NULLIF(t.tax_type, ''), 'percentage'),
      0,
      CURRENT_DATE
    FROM localization_pack_tax_templates t
    WHERE t.pack_id = _pack_id
      AND NOT EXISTS (
        SELECT 1 FROM tax_rates tr
        WHERE tr.organization_id = _org_id
          AND tr.business_id = _business_id
          AND tr.name = t.name
      )
    RETURNING 1
  )
  SELECT count(*) INTO _taxes_seeded FROM inserted;

  _step := 'seed_accounts_bulk';
  WITH header_codes AS (
    SELECT DISTINCT parent_code AS code
    FROM localization_pack_account_templates
    WHERE pack_id = _pack_id AND parent_code IS NOT NULL
  ),
  resolved AS (
    SELECT
      a.*,
      (CASE WHEN a.account_type = 'revenue' THEN 'income' ELSE a.account_type END) AS norm_account_type,
      EXISTS (SELECT 1 FROM header_codes h WHERE h.code = a.code) AS is_header_v
    FROM localization_pack_account_templates a
    WHERE a.pack_id = _pack_id
      AND a.role_key IS NULL
  ),
  inserted AS (
    INSERT INTO accounts (
      organization_id, business_id, code, name, account_type,
      description, cash_flow_category, is_system, is_active,
      is_header, detail_type, opening_balance, current_balance
    )
    SELECT
      _org_id, _business_id, r.code, r.name,
      r.norm_account_type::account_type,
      r.description, r.cash_flow_category, COALESCE(r.is_system, false), true,
      r.is_header_v,
      CASE
        WHEN r.is_header_v THEN NULL
        ELSE public._resolve_account_detail_type(NULL, r.norm_account_type, r.detail_type)
      END AS detail_type,
      0, 0
    FROM resolved r
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO _accounts_seeded FROM inserted;

  _step := 'seed_accounts_roles';
  FOR _r IN
    SELECT
      a.code, a.name, a.description, a.role_key,
      (CASE WHEN a.account_type = 'revenue' THEN 'income' ELSE a.account_type END) AS norm_account_type,
      public._resolve_account_detail_type(a.role_key,
        (CASE WHEN a.account_type = 'revenue' THEN 'income' ELSE a.account_type END),
        a.detail_type) AS resolved_detail_type
    FROM localization_pack_account_templates a
    WHERE a.pack_id = _pack_id AND a.role_key IS NOT NULL
  LOOP
    BEGIN
      _rid := public.upsert_system_account(
        _org_id, _business_id, _r.role_key,
        _r.norm_account_type, _r.resolved_detail_type,
        _r.code, _r.name, _r.description, NULL, false
      );
      IF _rid IS NOT NULL THEN
        _role_seeded := _role_seeded + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'pack-role upsert failed (% / %): %', _r.role_key, _r.code, SQLERRM;
    END;
  END LOOP;

  _accounts_seeded := _accounts_seeded + _role_seeded;

  _step := 'link_account_parents';
  UPDATE accounts child
    SET parent_id = parent.id
  FROM localization_pack_account_templates t
  JOIN accounts parent
    ON parent.organization_id = _org_id
   AND parent.business_id = _business_id
   AND parent.code = t.parent_code
  WHERE t.pack_id = _pack_id
    AND t.parent_code IS NOT NULL
    AND child.organization_id = _org_id
    AND child.business_id = _business_id
    AND child.code = t.code
    AND child.parent_id IS DISTINCT FROM parent.id;

  _step := 'seed_payroll_rules';
  WITH candidates AS (
    SELECT
      _org_id AS organization_id,
      _pack.country_code AS country_code,
      p.rule_type,
      p.rule_name,
      COALESCE(p.parameters->>'code',
               regexp_replace(lower(p.rule_name), '[^a-z0-9]+', '_', 'g'),
               p.rule_type) AS rule_code,
      COALESCE(p.parameters, '{}'::jsonb) AS parameters,
      COALESCE(NULLIF(p.computation_method, 'auto'), 'percentage_of_gross') AS computation_method,
      p.sort_order,
      NOT (p.parameters ? 'status' AND p.parameters->>'status' = 'replaced_by_shif') AS is_active,
      p.id AS template_id,
      _pack.version AS pack_version
    FROM localization_pack_payroll_templates p
    WHERE p.pack_id = _pack_id
  ),
  inserted AS (
    INSERT INTO payroll_statutory_rules (
      organization_id, country_code, rule_type, rule_name, rule_code,
      parameters, computation_method, sort_order, is_active,
      base_pack_template_id, base_pack_version, legacy_unvalidated
    )
    SELECT
      c.organization_id, c.country_code, c.rule_type, c.rule_name, c.rule_code,
      c.parameters, c.computation_method, c.sort_order, c.is_active,
      c.template_id, c.pack_version, false
    FROM candidates c
    WHERE NOT EXISTS (
      SELECT 1 FROM payroll_statutory_rules r
      WHERE r.organization_id = _org_id
        AND r.country_code = _pack.country_code
        AND r.rule_type = c.rule_type
        AND r.rule_name = c.rule_name
    )
    RETURNING 1
  )
  SELECT count(*) INTO _payroll_seeded FROM inserted;

  SELECT count(*) - _payroll_seeded INTO _payroll_skipped
    FROM localization_pack_payroll_templates WHERE pack_id = _pack_id;

  _step := 'record_installation';
  IF _existing.id IS NULL THEN
    INSERT INTO installed_localization_packs
      (organization_id, business_id, pack_id, pack_version, installed_by, status)
    VALUES (_org_id, _business_id, _pack_id, _pack.version, _installed_by, 'active');
  ELSE
    UPDATE installed_localization_packs
      SET pack_version = _pack.version, installed_at = now()
      WHERE id = _existing.id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_installed', _existing.id IS NOT NULL,
    'reseeded', _existing.id IS NOT NULL,
    'status', 'installed',
    'message', format(
      'Successfully %s "%s" v%s — %s statutory rule(s) added, %s tax(es), %s account(s) (incl. %s system roles).',
      CASE WHEN _existing.id IS NULL THEN 'installed' ELSE 'reseeded' END,
      _pack.name, _pack.version, _payroll_seeded, _taxes_seeded, _accounts_seeded, _role_seeded
    ),
    'summary', jsonb_build_object(
      'taxes_seeded', _taxes_seeded,
      'accounts_seeded', _accounts_seeded,
      'role_accounts_seeded', _role_seeded,
      'payroll_rules_seeded', _payroll_seeded,
      'payroll_rules_skipped_existing', _payroll_skipped
    )
  );

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS
    _sqlstate = RETURNED_SQLSTATE,
    _errmsg   = MESSAGE_TEXT,
    _errdetail = PG_EXCEPTION_DETAIL;
  RAISE EXCEPTION
    'install_localization_pack_atomic failed at step %: % (sqlstate %)',
    _step, _errmsg, _sqlstate
    USING ERRCODE = _sqlstate,
          DETAIL  = COALESCE(_errdetail, ''),
          HINT    = _step;
END;
$function$;


-- 7. Backfill any existing accounts whose detail_type drifted from the
--    canonical for their system_role. Safe — Wave 3 trigger guard
--    protects system_role, not detail_type.
UPDATE public.accounts a
   SET detail_type = t.detail_type
  FROM public.system_account_template t
 WHERE a.system_role IS NOT NULL
   AND a.system_role = t.role_key
   AND a.detail_type IS DISTINCT FROM t.detail_type
   AND coalesce(a.is_header, false) = false;


-- 8. CI guard: every role MUST have a template (otherwise the resolver
--    silently falls back and we re-introduce the COGS / detail_type bug).
DO $$
DECLARE missing text;
BEGIN
  SELECT r.role_key INTO missing
    FROM public.system_account_roles r
   WHERE NOT EXISTS (SELECT 1 FROM public.system_account_template t WHERE t.role_key = r.role_key)
   LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 2a invariant violated: system_account_template missing entry for role "%"', missing;
  END IF;
END $$;