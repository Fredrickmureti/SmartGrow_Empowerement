-- ============================================================================
-- Wave 3B: pack-scoped readiness rule seeding
-- ============================================================================

CREATE OR REPLACE FUNCTION public.gc_pack_readiness_rules(_org_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM payroll_readiness_rules r
  WHERE r.organization_id = _org_id
    AND r.source = 'pack'
    AND r.pack_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM installed_localization_packs ip
      WHERE ip.organization_id = _org_id
        AND ip.pack_id = r.pack_id
        AND ip.status = 'active'
    );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_pack_readiness_rules(_org_id uuid, _pack_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seeded int := 0;
  v_pack record;
  v_t record;
  v_r record;
  v_code text;
  v_predicate text;
BEGIN
  SELECT * INTO v_pack FROM localization_packs WHERE id = _pack_id;
  IF v_pack.id IS NULL THEN
    RETURN 0;
  END IF;

  -- 1) one rule per pack-declared statutory template
  FOR v_t IN
    SELECT
      COALESCE(p.parameters->>'code',
               regexp_replace(lower(p.rule_name), '[^a-z0-9]+', '_', 'g'),
               p.rule_type) AS rule_code,
      p.rule_name,
      p.rule_type
    FROM localization_pack_payroll_templates p
    WHERE p.pack_id = _pack_id
  LOOP
    v_code := 'pack.' || lower(v_pack.country_code) || '.statutory.' || v_t.rule_code;
    v_predicate := format(
      'SELECT EXISTS (SELECT 1 FROM payroll_statutory_rules WHERE organization_id = $1 AND rule_code = %L AND is_active = true AND (effective_to IS NULL OR effective_to >= COALESCE($5, CURRENT_DATE)))',
      v_t.rule_code
    );

    INSERT INTO payroll_readiness_rules (
      organization_id, pack_id, code, name, description, scope, severity,
      source, reason_code, check_kind, predicate_sql,
      remediation_label, remediation_link, is_active, sort_order
    ) VALUES (
      _org_id, _pack_id, v_code,
      v_t.rule_name || ' active',
      format('Active statutory rule required: %s (%s)', v_t.rule_name, v_t.rule_type),
      'org', 'fail',
      'pack', 'PACK_STATUTORY_MISSING',
      'pack.statutory_rule_active', v_predicate,
      'Activate ' || v_t.rule_name, '/hr/payroll/statutory-rules',
      true, 100
    )
    ON CONFLICT (organization_id, code) DO UPDATE
      SET pack_id = EXCLUDED.pack_id,
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          predicate_sql = EXCLUDED.predicate_sql,
          remediation_label = EXCLUDED.remediation_label,
          remediation_link = EXCLUDED.remediation_link,
          is_active = true,
          updated_at = now();
    v_seeded := v_seeded + 1;
  END LOOP;

  -- 2) one rule per pack-declared remittance schedule with a liability setting key
  FOR v_r IN
    SELECT rs.rule_code, rs.authority_name, rs.liability_account_setting_key
    FROM localization_pack_remittance_schedules rs
    WHERE rs.pack_id = _pack_id
      AND rs.liability_account_setting_key IS NOT NULL
      AND length(trim(rs.liability_account_setting_key)) > 0
  LOOP
    v_code := 'pack.' || lower(v_pack.country_code) || '.remittance_mapping.' || v_r.liability_account_setting_key;
    v_predicate := format(
      'SELECT EXISTS (SELECT 1 FROM default_account_settings WHERE organization_id = $1 AND setting_key = %L AND account_id IS NOT NULL)',
      v_r.liability_account_setting_key
    );

    INSERT INTO payroll_readiness_rules (
      organization_id, pack_id, code, name, description, scope, severity,
      source, reason_code, check_kind, predicate_sql,
      remediation_label, remediation_link, is_active, sort_order
    ) VALUES (
      _org_id, _pack_id, v_code,
      v_r.authority_name || ' liability account mapped',
      format('Liability account for %s remittance (%s) must be mapped.',
             v_r.authority_name, v_r.liability_account_setting_key),
      'org', 'fail',
      'pack', 'PACK_REMITTANCE_ACCOUNT_MISSING',
      'pack.remittance_liability_mapped', v_predicate,
      'Map ' || v_r.authority_name || ' liability account',
      '/hr/payroll/configuration/accounts',
      true, 110
    )
    ON CONFLICT (organization_id, code) DO UPDATE
      SET pack_id = EXCLUDED.pack_id,
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          predicate_sql = EXCLUDED.predicate_sql,
          remediation_label = EXCLUDED.remediation_label,
          remediation_link = EXCLUDED.remediation_link,
          is_active = true,
          updated_at = now();
    v_seeded := v_seeded + 1;
  END LOOP;

  -- Drop stale pack rules for packs no longer installed
  PERFORM public.gc_pack_readiness_rules(_org_id);

  RETURN v_seeded;
END;
$$;

GRANT EXECUTE ON FUNCTION public.gc_pack_readiness_rules(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.seed_pack_readiness_rules(uuid, uuid) TO authenticated, service_role;

-- ============================================================================
-- Patch install_localization_pack_atomic to call the seeder after install
-- ============================================================================

CREATE OR REPLACE FUNCTION public.install_localization_pack_atomic(_business_id uuid, _pack_id uuid, _installed_by uuid, _force_reseed boolean DEFAULT false)
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
  _account_roles_mirrored int := 0;
  _remittance_schedules int := 0;
  _readiness_rules_seeded int := 0;
  _step text;
  _rid uuid;
  _r record;
BEGIN
  _step := 'lookup_business';
  SELECT organization_id INTO _org_id FROM businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id
      USING ERRCODE = 'P0002', HINT = _step;
  END IF;

  _step := 'lookup_pack';
  SELECT * INTO _pack FROM localization_packs
    WHERE id = _pack_id AND is_active = true AND is_published = true;
  IF _pack.id IS NULL THEN
    RAISE EXCEPTION 'Localization pack % not found or not published', _pack_id
      USING ERRCODE = 'P0002', HINT = _step;
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
    INSERT INTO tax_rates (organization_id, business_id, name, rate, description,
                           is_compound, is_inclusive, is_default, is_active)
    SELECT _org_id, _business_id, t.name, t.rate, t.description,
           t.is_compound, t.is_inclusive, t.is_default, true
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
    SELECT a.*,
      (CASE WHEN a.account_type = 'revenue' THEN 'income' ELSE a.account_type END) AS norm_account_type,
      EXISTS (SELECT 1 FROM header_codes h WHERE h.code = a.code) AS is_header_v
    FROM localization_pack_account_templates a
    WHERE a.pack_id = _pack_id AND a.role_key IS NULL
  ),
  inserted AS (
    INSERT INTO accounts (
      organization_id, business_id, code, name, account_type,
      description, cash_flow_category, is_system, is_active,
      is_header, detail_type, opening_balance, current_balance
    )
    SELECT _org_id, _business_id, r.code, r.name,
      r.norm_account_type::account_type, r.description, r.cash_flow_category,
      false,
      true, r.is_header_v,
      CASE WHEN r.is_header_v THEN NULL
           ELSE public._resolve_account_detail_type(NULL, r.norm_account_type, r.detail_type)
      END,
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
    _rid := public.upsert_system_account(
      _org_id, _business_id, _r.role_key,
      _r.norm_account_type, _r.resolved_detail_type,
      _r.code, _r.name, _r.description, NULL, false);
    IF _rid IS NOT NULL THEN _role_seeded := _role_seeded + 1; END IF;
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
      NOT (p.parameters ? 'status' AND p.parameters->>'status' = 'replaced_by_shif') AS is_active
    FROM localization_pack_payroll_templates p
    WHERE p.pack_id = _pack_id
  ),
  inserted AS (
    INSERT INTO payroll_statutory_rules
      (organization_id, country_code, rule_type, rule_name, rule_code,
       parameters, computation_method, sort_order, is_active)
    SELECT c.organization_id, c.country_code, c.rule_type, c.rule_name, c.rule_code,
           c.parameters, c.computation_method, c.sort_order, c.is_active
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

  _step := 'mirror_pack_account_roles';
  BEGIN
    SELECT public.payroll_install_pack_account_roles(_pack_id) INTO _account_roles_mirrored;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'payroll_install_pack_account_roles failed: %', SQLERRM;
    _account_roles_mirrored := 0;
  END;

  _step := 'count_remittance_schedules';
  SELECT count(*) INTO _remittance_schedules
    FROM public.localization_pack_remittance_schedules
    WHERE pack_id = _pack_id;

  _step := 'seed_pack_readiness_rules';
  BEGIN
    SELECT public.seed_pack_readiness_rules(_org_id, _pack_id) INTO _readiness_rules_seeded;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'seed_pack_readiness_rules failed: %', SQLERRM;
    _readiness_rules_seeded := 0;
  END;

  _step := 'record_install';
  IF _existing.id IS NULL THEN
    INSERT INTO installed_localization_packs
      (organization_id, business_id, pack_id, pack_version, installed_by, status)
    VALUES (_org_id, _business_id, _pack_id, _pack.version, _installed_by, 'active');
  ELSE
    UPDATE installed_localization_packs
      SET pack_version = _pack.version, installed_at = now()
      WHERE id = _existing.id;
  END IF;

  -- Re-evaluate org-scope readiness so the new pack rules surface immediately.
  BEGIN
    PERFORM public.evaluate_payroll_readiness(_org_id, _business_id, 'org', NULL, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'post-install readiness eval failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'already_installed', _existing.id IS NOT NULL,
    'reseeded', _existing.id IS NOT NULL,
    'status', 'installed',
    'message', format('Successfully %s "%s" v%s — %s statutory rule(s), %s tax(es), %s account(s), %s role(s) mirrored, %s remittance schedule(s), %s readiness rule(s) seeded.',
      CASE WHEN _existing.id IS NULL THEN 'installed' ELSE 'reseeded' END,
      _pack.name, _pack.version, _payroll_seeded, _taxes_seeded, _accounts_seeded,
      _account_roles_mirrored, _remittance_schedules, _readiness_rules_seeded),
    'summary', jsonb_build_object(
      'taxes_seeded', _taxes_seeded,
      'accounts_seeded', _accounts_seeded,
      'role_accounts_seeded', _role_seeded,
      'payroll_rules_seeded', _payroll_seeded,
      'payroll_rules_skipped_existing', _payroll_skipped,
      'account_roles_mirrored', _account_roles_mirrored,
      'remittance_schedules_declared', _remittance_schedules,
      'readiness_rules_seeded', _readiness_rules_seeded
    )
  );
END;
$function$;