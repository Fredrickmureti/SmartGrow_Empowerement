-- =====================================================================
-- Wave 1C.3: route the remaining 3 provisioning functions through
-- upsert_system_account so no path can create parallel system rows.
--
--   * provision_default_chart_of_accounts  (per-row template loop)
--   * install_localization_pack_atomic     (bulk pack seed, two-pass)
--   * payroll_create_and_map_account       (per-statutory-key)
--
-- Non-role template rows keep the direct INSERT path (they are not
-- system accounts). Role rows always go through upsert_system_account,
-- which is idempotent on (business_id, system_role).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. provision_default_chart_of_accounts
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.provision_default_chart_of_accounts(
  _org_id uuid, _business_id uuid, _country_code text DEFAULT NULL::text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _template public.default_chart_of_accounts%ROWTYPE;
  _parent_id uuid;
  _new_id uuid;
  _code_to_id jsonb := '{}'::jsonb;
  _accounts_created integer := 0;
  _resolved_country text := upper(coalesce(_country_code, 'INT'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.default_chart_of_accounts WHERE country_code = _resolved_country LIMIT 1) THEN
    _resolved_country := 'INT';
  END IF;

  FOR _template IN
    SELECT * FROM public.default_chart_of_accounts
    WHERE country_code = _resolved_country AND is_country_neutral = true
      AND account_name !~* '\m(nhif|shif|paye|nssf|housing\s*levy|uif|sdl|wcf|skills\s*levy|gratuity|epf|esic|provident\s*fund|pf\s*payable|kra|sars|ura|tra|bir)\m'
    ORDER BY account_code
  LOOP
    _parent_id := NULL;
    IF _template.parent_code IS NOT NULL THEN
      _parent_id := NULLIF(_code_to_id->>_template.parent_code, '')::uuid;
    END IF;

    _new_id := NULL;

    IF _template.role_key IS NOT NULL THEN
      -- Role-bearing template: route through the canonical helper so the
      -- (business_id, system_role) invariant is enforced and any prior
      -- orphan with this role is adopted instead of duplicated.
      BEGIN
        _new_id := public.upsert_system_account(
          _org_id, _business_id, _template.role_key,
          _template.account_type::text, _template.detail_type,
          _template.account_code, _template.account_name,
          _template.description, _parent_id, false
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'upsert_system_account failed for role %: %', _template.role_key, SQLERRM;
        _new_id := NULL;
      END;
    ELSE
      INSERT INTO public.accounts (
        organization_id, business_id, code, name, account_type,
        detail_type, parent_id, description, is_system, is_active
      ) VALUES (
        _org_id, _business_id, _template.account_code, _template.account_name,
        _template.account_type, _template.detail_type,
        _parent_id, _template.description,
        coalesce(_template.is_system, false), true
      )
      ON CONFLICT DO NOTHING
      RETURNING id INTO _new_id;
    END IF;

    IF _new_id IS NOT NULL THEN
      _code_to_id := _code_to_id || jsonb_build_object(_template.account_code, _new_id::text);
      _accounts_created := _accounts_created + 1;
    END IF;
  END LOOP;

  PERFORM public.backfill_account_detail_types(_org_id, _business_id);

  BEGIN
    PERFORM public.provision_missing_system_accounts(_org_id, _business_id, false);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'provision_missing_system_accounts failed for biz %: %', _business_id, SQLERRM;
  END;

  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  SELECT a.organization_id, a.business_id, 'opening_balance_equity', a.id
  FROM public.accounts a
  WHERE a.business_id = _business_id AND a.detail_type = 'opening_balance_equity' AND a.is_active = true
    AND NOT EXISTS (SELECT 1 FROM public.default_account_settings d
                    WHERE d.business_id = a.business_id AND d.setting_key = 'opening_balance_equity')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.default_account_settings (organization_id, business_id, setting_key, account_id)
  SELECT a.organization_id, a.business_id, 'suspense', a.id
  FROM public.accounts a
  WHERE a.business_id = _business_id AND a.detail_type = 'suspense' AND a.is_active = true
    AND NOT EXISTS (SELECT 1 FROM public.default_account_settings d
                    WHERE d.business_id = a.business_id AND d.setting_key = 'suspense')
  ON CONFLICT DO NOTHING;

  RETURN _accounts_created;
END;
$function$;

-- ---------------------------------------------------------------------
-- 2. install_localization_pack_atomic
--   Two-pass account seed:
--     (a) bulk INSERT for non-role templates (header tree, leaves w/o role)
--     (b) per-row upsert_system_account for role templates
--   Parent linkage stays code-based via the existing UPDATE join.
-- ---------------------------------------------------------------------
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

  -- Pass A: bulk seed non-role templates (headers + role-less leaves).
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
      AND a.role_key IS NULL  -- role rows handled in Pass B
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
        WHEN r.detail_type IS NOT NULL THEN r.detail_type
        ELSE CASE r.norm_account_type
          WHEN 'asset'     THEN 'other_current_asset'
          WHEN 'liability' THEN 'other_current_liabilities'
          WHEN 'equity'    THEN 'other_equity'
          WHEN 'income'    THEN 'other_business_income'
          WHEN 'expense'   THEN 'other_business_expenses'
          ELSE NULL
        END
      END AS detail_type,
      0, 0
    FROM resolved r
    WHERE NOT EXISTS (
      SELECT 1 FROM accounts ac
      WHERE ac.organization_id = _org_id
        AND ac.business_id = _business_id
        AND ac.code = r.code
    )
    RETURNING 1
  )
  SELECT count(*) INTO _accounts_seeded FROM inserted;

  -- Pass B: route every role template through upsert_system_account.
  _step := 'seed_accounts_roles';
  FOR _r IN
    SELECT
      a.code, a.name, a.description, a.role_key,
      COALESCE(a.detail_type, CASE
        WHEN a.account_type = 'revenue' THEN 'other_business_income'
        WHEN a.account_type = 'asset' THEN 'other_current_asset'
        WHEN a.account_type = 'liability' THEN 'other_current_liabilities'
        WHEN a.account_type = 'equity' THEN 'other_equity'
        WHEN a.account_type = 'income' THEN 'other_business_income'
        WHEN a.account_type = 'expense' THEN 'other_business_expenses'
      END) AS detail_type,
      (CASE WHEN a.account_type = 'revenue' THEN 'income' ELSE a.account_type END) AS norm_account_type
    FROM localization_pack_account_templates a
    WHERE a.pack_id = _pack_id AND a.role_key IS NOT NULL
  LOOP
    BEGIN
      _rid := public.upsert_system_account(
        _org_id, _business_id, _r.role_key,
        _r.norm_account_type, _r.detail_type,
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

-- ---------------------------------------------------------------------
-- 3. payroll_create_and_map_account
--   When the _setting_key is a registered system_account_roles.role_key,
--   route through upsert_system_account so we never spawn a parallel
--   system row for the same role. Otherwise keep the legacy direct path.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_create_and_map_account(
  _org_id uuid, _business_id uuid, _setting_key text, _name text,
  _account_type text, _code text DEFAULT NULL::text, _branch_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_account_id uuid; v_code text; v_prefix text;
  v_lname text := lower(coalesce(_name, ''));
  v_is_role boolean := false;
  v_detail_type text;
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
  IF (_setting_key LIKE '%\_payable' ESCAPE '\')
     AND lower(_account_type) <> 'liability' THEN
    RAISE EXCEPTION 'payroll_mapping_role_violation: setting_key % requires _account_type=liability', _setting_key USING ERRCODE = '22023';
  END IF;

  v_prefix := CASE lower(_account_type)
    WHEN 'expense' THEN '6900' WHEN 'liability' THEN '2300'
    WHEN 'asset' THEN '1900' WHEN 'income' THEN '4900'
    WHEN 'equity' THEN '3900' ELSE '9000'
  END;
  v_code := COALESCE(_code, v_prefix || '-' || upper(left(regexp_replace(_setting_key, '[^a-zA-Z0-9]', '', 'g'), 10)));

  -- Is this setting_key a registered system role?
  SELECT EXISTS (
    SELECT 1 FROM public.system_account_roles WHERE role_key = _setting_key
  ) INTO v_is_role;

  IF v_is_role THEN
    v_detail_type := CASE lower(_account_type)
      WHEN 'expense'   THEN 'other_business_expenses'
      WHEN 'liability' THEN 'other_current_liabilities'
      WHEN 'asset'     THEN 'other_current_asset'
      WHEN 'income'    THEN 'other_business_income'
      WHEN 'equity'    THEN 'other_equity'
      ELSE 'other_current_asset'
    END;
    v_account_id := public.upsert_system_account(
      _org_id, _business_id, _setting_key,
      lower(_account_type), v_detail_type,
      v_code, _name, NULL, NULL, false
    );
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.accounts
      WHERE organization_id = _org_id
        AND (business_id IS NULL OR business_id = _business_id) AND code = v_code
    ) THEN
      v_code := v_code || '-' || substring(gen_random_uuid()::text, 1, 4);
    END IF;

    INSERT INTO public.accounts (organization_id, business_id, code, name, account_type, is_active, is_header)
    VALUES (_org_id, _business_id, v_code, _name, _account_type::public.account_type_enum, true, false)
    RETURNING id INTO v_account_id;
  END IF;

  PERFORM public._payroll_assert_mapping_role(_setting_key, v_account_id);
  PERFORM public._upsert_default_account_setting(_org_id, _business_id, _branch_id, _setting_key, v_account_id);
  PERFORM public.refresh_payroll_setup_status(_org_id, _business_id);
  RETURN v_account_id;
END;
$function$;