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
      'org', 'block',
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
          severity = EXCLUDED.severity,
          is_active = true,
          updated_at = now();
    v_seeded := v_seeded + 1;
  END LOOP;

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
      'org', 'block',
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
          severity = EXCLUDED.severity,
          is_active = true,
          updated_at = now();
    v_seeded := v_seeded + 1;
  END LOOP;

  PERFORM public.gc_pack_readiness_rules(_org_id);

  RETURN v_seeded;
END;
$$;