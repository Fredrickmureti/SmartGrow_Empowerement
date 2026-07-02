-- =====================================================================
-- Finance / Payroll / Localization remediation (root-cause fixes)
-- =====================================================================

-- 1. Fix install_localization_pack_atomic: non-role pack rows must NOT
--    set is_system=true (the accounts_is_system_requires_role check
--    constraint rejects is_system=true without a system_role). Header
--    rows from packs are ordinary CoA structure, not registry-owned.
CREATE OR REPLACE FUNCTION public.install_localization_pack_atomic(
  _business_id uuid, _pack_id uuid, _installed_by uuid, _force_reseed boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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
  _sqlstate text; _errmsg text; _errdetail text;
  _r record; _rid uuid; _lock_key bigint;
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
      'success', true, 'already_installed', true, 'status', 'installed',
      'message', format('Pack "%s" is already installed (v%s). Use force_reseed=true to re-apply.',
                        _pack.name, _existing.pack_version));
  END IF;

  _step := 'seed_tax_rates';
  WITH inserted AS (
    INSERT INTO tax_rates (
      organization_id, business_id, name, rate, description,
      is_compound, is_inclusive, is_default, is_active,
      tax_type, fixed_amount, effective_from)
    SELECT _org_id, _business_id, t.name, t.rate, t.description,
           t.is_compound, t.is_inclusive, t.is_default, true,
           COALESCE(NULLIF(t.tax_type, ''), 'percentage'), 0, CURRENT_DATE
    FROM localization_pack_tax_templates t
    WHERE t.pack_id = _pack_id
      AND NOT EXISTS (SELECT 1 FROM tax_rates tr
                      WHERE tr.organization_id = _org_id
                        AND tr.business_id = _business_id
                        AND tr.name = t.name)
    RETURNING 1)
  SELECT count(*) INTO _taxes_seeded FROM inserted;

  _step := 'seed_accounts_bulk';
  WITH header_codes AS (
    SELECT DISTINCT parent_code AS code FROM localization_pack_account_templates
     WHERE pack_id = _pack_id AND parent_code IS NOT NULL),
  resolved AS (
    SELECT a.*,
      (CASE WHEN a.account_type = 'revenue' THEN 'income' ELSE a.account_type END) AS norm_account_type,
      EXISTS (SELECT 1 FROM header_codes h WHERE h.code = a.code) AS is_header_v
    FROM localization_pack_account_templates a
    WHERE a.pack_id = _pack_id AND a.role_key IS NULL),
  inserted AS (
    INSERT INTO accounts (
      organization_id, business_id, code, name, account_type,
      description, cash_flow_category, is_system, is_active,
      is_header, detail_type, opening_balance, current_balance)
    SELECT _org_id, _business_id, r.code, r.name,
      r.norm_account_type::account_type, r.description, r.cash_flow_category,
      false,  -- non-role pack rows are not registry-owned; do not mark is_system
      true, r.is_header_v,
      CASE WHEN r.is_header_v THEN NULL
           ELSE public._resolve_account_detail_type(NULL, r.norm_account_type, r.detail_type) END,
      0, 0
    FROM resolved r
    ON CONFLICT DO NOTHING
    RETURNING 1)
  SELECT count(*) INTO _accounts_seeded FROM inserted;

  _step := 'seed_accounts_roles';
  FOR _r IN
    SELECT a.code, a.name, a.description, a.role_key,
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
        _r.code, _r.name, _r.description, NULL, false);
      IF _rid IS NOT NULL THEN _role_seeded := _role_seeded + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'pack-role upsert failed (% / %): %', _r.role_key, _r.code, SQLERRM;
    END;
  END LOOP;

  _accounts_seeded := _accounts_seeded + _role_seeded;

  _step := 'link_account_parents';
  UPDATE accounts child SET parent_id = parent.id
  FROM localization_pack_account_templates t
  JOIN accounts parent ON parent.organization_id = _org_id
   AND parent.business_id = _business_id AND parent.code = t.parent_code
  WHERE t.pack_id = _pack_id AND t.parent_code IS NOT NULL
    AND child.organization_id = _org_id AND child.business_id = _business_id
    AND child.code = t.code AND child.parent_id IS DISTINCT FROM parent.id;

  _step := 'seed_payroll_rules';
  WITH candidates AS (
    SELECT _org_id AS organization_id, _pack.country_code AS country_code,
      p.rule_type, p.rule_name,
      COALESCE(p.parameters->>'code',
               regexp_replace(lower(p.rule_name), '[^a-z0-9]+', '_', 'g'),
               p.rule_type) AS rule_code,
      COALESCE(p.parameters, '{}'::jsonb) AS parameters,
      COALESCE(NULLIF(p.computation_method, 'auto'), 'percentage_of_gross') AS computation_method,
      p.sort_order,
      NOT (p.parameters ? 'status' AND p.parameters->>'status' = 'replaced_by_shif') AS is_active,
      p.id AS template_id, _pack.version AS pack_version
    FROM localization_pack_payroll_templates p WHERE p.pack_id = _pack_id),
  inserted AS (
    INSERT INTO payroll_statutory_rules (
      organization_id, country_code, rule_type, rule_name, rule_code,
      parameters, computation_method, sort_order, is_active,
      base_pack_template_id, base_pack_version, legacy_unvalidated)
    SELECT c.organization_id, c.country_code, c.rule_type, c.rule_name, c.rule_code,
      c.parameters, c.computation_method, c.sort_order, c.is_active,
      c.template_id, c.pack_version, false
    FROM candidates c
    WHERE NOT EXISTS (
      SELECT 1 FROM payroll_statutory_rules r
      WHERE r.organization_id = _org_id
        AND r.country_code = _pack.country_code
        AND r.rule_type = c.rule_type AND r.rule_name = c.rule_name)
    RETURNING 1)
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
    'success', true, 'already_installed', _existing.id IS NOT NULL,
    'reseeded', _existing.id IS NOT NULL, 'status', 'installed',
    'message', format(
      'Successfully %s "%s" v%s — %s statutory rule(s) added, %s tax(es), %s account(s) (incl. %s system roles).',
      CASE WHEN _existing.id IS NULL THEN 'installed' ELSE 'reseeded' END,
      _pack.name, _pack.version, _payroll_seeded, _taxes_seeded, _accounts_seeded, _role_seeded),
    'summary', jsonb_build_object(
      'taxes_seeded', _taxes_seeded, 'accounts_seeded', _accounts_seeded,
      'role_accounts_seeded', _role_seeded,
      'payroll_rules_seeded', _payroll_seeded,
      'payroll_rules_skipped_existing', _payroll_skipped));

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS
    _sqlstate = RETURNED_SQLSTATE, _errmsg = MESSAGE_TEXT, _errdetail = PG_EXCEPTION_DETAIL;
  RAISE EXCEPTION
    'install_localization_pack_atomic failed at step %: % (sqlstate %)',
    _step, _errmsg, _sqlstate
    USING ERRCODE = _sqlstate, DETAIL = COALESCE(_errdetail, ''), HINT = _step;
END;
$function$;

-- 2. Add canonical statutory codes to Kenya payroll templates so the
--    readiness matcher resolves to the registered system_account_roles.
UPDATE public.localization_pack_payroll_templates SET parameters = parameters || jsonb_build_object('code', code_val)
FROM (VALUES
  ('PAYE (Pay As You Earn)',                        'paye'),
  ('NSSF (National Social Security Fund)',          'nssf'),
  ('SHIF (Social Health Insurance Fund)',           'shif'),
  ('Affordable Housing Levy (AHL)',                 'housing_levy'),
  ('NITA (National Industrial Training Authority)', 'nita'),
  ('NHIF (Legacy Rates - Reference Only)',          'nhif')
) AS m(rule_name, code_val)
WHERE public.localization_pack_payroll_templates.pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid
  AND public.localization_pack_payroll_templates.rule_name = m.rule_name
  AND COALESCE(public.localization_pack_payroll_templates.parameters->>'code', '') <> m.code_val;

-- 3. Archive duplicate Kenya pack template: 6151 "NSSF Employer Contribution"
--    overlaps the canonical 6011 employer_nssf_expense role row.
DELETE FROM public.localization_pack_account_templates
WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid
  AND code = '6151'
  AND lower(name) ~ 'nssf';

-- 4. Fix invalid type cast in runtime payroll account creator
--    (public.account_type_enum does not exist; the enum is public.account_type).
CREATE OR REPLACE FUNCTION public.payroll_create_and_map_account(
  _org_id uuid, _business_id uuid, _setting_key text, _name text,
  _account_type text, _code text DEFAULT NULL::text, _branch_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_is_service boolean := (current_setting('request.jwt.claims', true)::jsonb->>'role') = 'service_role';
  v_account_id uuid; v_existing_mapped_id uuid; v_existing_code_id uuid;
  v_code text; v_prefix text; v_lname text := lower(coalesce(_name, ''));
  v_is_role boolean := false; v_detail_type text; v_lock_key bigint;
BEGIN
  IF NOT v_is_service THEN
    IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_user AND ur.organization_id = _org_id AND ur.is_active = true)
    THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
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
    SELECT suggested_code INTO v_code FROM public.system_account_template
     WHERE role_key = _setting_key AND account_type::text = lower(_account_type) LIMIT 1;
  END IF;

  IF v_code IS NULL THEN
    v_prefix := CASE lower(_account_type)
      WHEN 'expense' THEN '6900' WHEN 'liability' THEN '2300'
      WHEN 'asset' THEN '1900' WHEN 'income' THEN '4900'
      WHEN 'equity' THEN '3900' ELSE '9000' END;
    v_code := COALESCE(_code, v_prefix || '-' || upper(left(regexp_replace(_setting_key, '[^a-zA-Z0-9]', '', 'g'), 10)));
  END IF;

  IF v_is_role THEN
    v_detail_type := public._resolve_account_detail_type(_setting_key, lower(_account_type), NULL);
    v_account_id := public.upsert_system_account(
      _org_id, _business_id, _setting_key,
      lower(_account_type), v_detail_type,
      v_code, _name, NULL, NULL, false);
  ELSE
    SELECT account_id INTO v_existing_mapped_id
      FROM public.default_account_settings
     WHERE organization_id = _org_id
       AND (business_id IS NULL OR business_id = _business_id)
       AND setting_key = _setting_key LIMIT 1;
    IF v_existing_mapped_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.accounts WHERE id = v_existing_mapped_id AND is_active = true) THEN
      v_account_id := v_existing_mapped_id;
    ELSE
      SELECT id INTO v_existing_code_id
        FROM public.accounts
       WHERE organization_id = _org_id
         AND (business_id IS NULL OR business_id = _business_id)
         AND code = v_code LIMIT 1;
      IF v_existing_code_id IS NOT NULL THEN
        v_account_id := v_existing_code_id;
      ELSE
        INSERT INTO public.accounts (organization_id, business_id, code, name, account_type, is_active, is_header)
        VALUES (_org_id, _business_id, v_code, _name, _account_type::public.account_type, true, false)
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

-- 5. Drop the diagnostic table
DROP TABLE IF EXISTS public._install_diag;