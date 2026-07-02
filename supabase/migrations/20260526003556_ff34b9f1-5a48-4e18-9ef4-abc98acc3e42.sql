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
  _payroll_seeded int := 0;
  _payroll_skipped int := 0;
BEGIN
  SELECT organization_id INTO _org_id FROM businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO _pack FROM localization_packs
    WHERE id = _pack_id AND is_active = true AND is_published = true;
  IF _pack.id IS NULL THEN
    RAISE EXCEPTION 'Localization pack % not found or not published', _pack_id USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO _existing FROM installed_localization_packs
    WHERE business_id = _business_id AND pack_id = _pack_id;

  IF _existing.id IS NOT NULL AND NOT _force_reseed THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_installed', true,
      'status', 'installed',
      'message', format('Pack "%s" is already installed (v%s). Use force_reseed=true to re-apply.', _pack.name, _existing.pack_version)
    );
  END IF;

  WITH inserted AS (
    INSERT INTO tax_rates (organization_id, business_id, name, rate, description, is_compound, is_inclusive, is_default, is_active)
    SELECT _org_id, _business_id, t.name, t.rate, t.description, t.is_compound, t.is_inclusive, t.is_default, true
    FROM localization_pack_tax_templates t
    WHERE t.pack_id = _pack_id
      AND NOT EXISTS (
        SELECT 1 FROM tax_rates tr
        WHERE tr.organization_id = _org_id AND tr.business_id = _business_id AND tr.name = t.name
      )
    RETURNING 1
  )
  SELECT count(*) INTO _taxes_seeded FROM inserted;

  WITH inserted AS (
    INSERT INTO accounts (organization_id, business_id, code, name, account_type, description, cash_flow_category, is_system, is_active, opening_balance, current_balance)
    SELECT _org_id, _business_id, a.code, a.name,
           (CASE WHEN a.account_type = 'revenue' THEN 'income' ELSE a.account_type END)::account_type,
           a.description, a.cash_flow_category, COALESCE(a.is_system, false), true, 0, 0
    FROM localization_pack_account_templates a
    WHERE a.pack_id = _pack_id
      AND NOT EXISTS (
        SELECT 1 FROM accounts ac
        WHERE ac.organization_id = _org_id AND ac.business_id = _business_id AND ac.code = a.code
      )
    RETURNING 1
  )
  SELECT count(*) INTO _accounts_seeded FROM inserted;

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

  WITH candidates AS (
    SELECT
      _org_id AS organization_id,
      _pack.country_code AS country_code,
      p.rule_type,
      p.rule_name,
      COALESCE(p.parameters->>'code', regexp_replace(lower(p.rule_name), '[^a-z0-9]+', '_', 'g'), p.rule_type) AS rule_code,
      COALESCE(p.parameters, '{}'::jsonb) AS parameters,
      COALESCE(NULLIF(p.computation_method, 'auto'), 'percentage_of_gross') AS computation_method,
      p.sort_order,
      NOT (p.parameters ? 'status' AND p.parameters->>'status' = 'replaced_by_shif') AS is_active
    FROM localization_pack_payroll_templates p
    WHERE p.pack_id = _pack_id
  ),
  inserted AS (
    INSERT INTO payroll_statutory_rules
      (organization_id, country_code, rule_type, rule_name, rule_code, parameters, computation_method, sort_order, is_active)
    SELECT c.organization_id, c.country_code, c.rule_type, c.rule_name, c.rule_code, c.parameters, c.computation_method, c.sort_order, c.is_active
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
    'message', format('Successfully %s "%s" v%s — %s statutory rule(s) added, %s tax(es), %s account(s).',
      CASE WHEN _existing.id IS NULL THEN 'installed' ELSE 'reseeded' END,
      _pack.name, _pack.version, _payroll_seeded, _taxes_seeded, _accounts_seeded),
    'summary', jsonb_build_object(
      'taxes_seeded', _taxes_seeded,
      'accounts_seeded', _accounts_seeded,
      'payroll_rules_seeded', _payroll_seeded,
      'payroll_rules_skipped_existing', _payroll_skipped
    )
  );
END;
$function$;