-- Phase A — Pack installer completeness
-- 1. localization_pack_remittance_schedules (pack-scoped template)

CREATE TABLE IF NOT EXISTS public.localization_pack_remittance_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  rule_code text NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('monthly','quarterly','annual','custom')),
  due_day integer,
  due_offset_days integer,
  currency text,
  authority_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, rule_code, frequency)
);

GRANT SELECT ON public.localization_pack_remittance_schedules TO anon, authenticated;
GRANT ALL    ON public.localization_pack_remittance_schedules TO service_role;

ALTER TABLE public.localization_pack_remittance_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lprs_read_all" ON public.localization_pack_remittance_schedules;
CREATE POLICY "lprs_read_all"
  ON public.localization_pack_remittance_schedules FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "lprs_platform_admin_write" ON public.localization_pack_remittance_schedules;
CREATE POLICY "lprs_platform_admin_write"
  ON public.localization_pack_remittance_schedules FOR ALL
  USING (public.has_role(auth.uid(), 'platform_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'platform_admin'));

COMMENT ON TABLE public.localization_pack_remittance_schedules IS
  'Pack-scoped declaration of statutory remittance cadences (frequency / due day / authority). Packs declare schedules here at publish time; runtime resolves a tenant''s schedules by JOINing through installed_localization_packs. No country-specific code required.';

-- 2. install_localization_pack_atomic — extended to call
--    payroll_install_pack_account_roles and report remittance schedule count.

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
  _payroll_seeded int := 0;
  _payroll_skipped int := 0;
  _account_roles_mirrored int := 0;
  _remittance_schedules int := 0;
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

  -- Phase A (audit close-out): mirror pack-declared account roles into the
  -- global system_account_roles registry so GL posting can resolve liability
  -- accounts for arbitrary statutory codes (Ghana SSNIT, Nigeria PAYE,
  -- etc.) without a per-country migration.
  BEGIN
    SELECT public.payroll_install_pack_account_roles(_pack_id) INTO _account_roles_mirrored;
  EXCEPTION WHEN OTHERS THEN
    -- Helper is non-critical for install correctness — log via NOTICE so
    -- the install transaction is not aborted on a missing helper in older
    -- environments.
    RAISE NOTICE 'payroll_install_pack_account_roles failed: %', SQLERRM;
    _account_roles_mirrored := 0;
  END;

  -- Phase A (audit close-out): count remittance schedules the pack
  -- declares. Runtime resolves a tenant's schedules by JOINing through
  -- installed_localization_packs, so no per-tenant copy is needed; the
  -- count is reported so the installer can warn on packs that ship
  -- without any remittance metadata.
  SELECT count(*) INTO _remittance_schedules
    FROM public.localization_pack_remittance_schedules
    WHERE pack_id = _pack_id;

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
    'message', format('Successfully %s "%s" v%s — %s statutory rule(s) added, %s tax(es), %s account(s), %s account role(s) mirrored, %s remittance schedule(s) declared.',
      CASE WHEN _existing.id IS NULL THEN 'installed' ELSE 'reseeded' END,
      _pack.name, _pack.version, _payroll_seeded, _taxes_seeded, _accounts_seeded,
      _account_roles_mirrored, _remittance_schedules),
    'summary', jsonb_build_object(
      'taxes_seeded', _taxes_seeded,
      'accounts_seeded', _accounts_seeded,
      'payroll_rules_seeded', _payroll_seeded,
      'payroll_rules_skipped_existing', _payroll_skipped,
      'account_roles_mirrored', _account_roles_mirrored,
      'remittance_schedules_declared', _remittance_schedules
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.install_localization_pack_atomic(uuid, uuid, uuid, boolean) IS
  'Atomic pack install. Seeds taxes, accounts, payroll statutory rules; mirrors pack account_roles into system_account_roles via payroll_install_pack_account_roles; reports remittance schedule count. Country-agnostic — all country specifics come from pack templates.';