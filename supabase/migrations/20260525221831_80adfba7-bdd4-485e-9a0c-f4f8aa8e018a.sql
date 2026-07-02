
-- Phase 5: Pack lifecycle

-- 1. superseded_by on payroll_statutory_rules
ALTER TABLE public.payroll_statutory_rules
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES public.payroll_statutory_rules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_statutory_rules_superseded_by
  ON public.payroll_statutory_rules(superseded_by) WHERE superseded_by IS NOT NULL;

-- 2. due_date_snapshot on payroll_remittances
ALTER TABLE public.payroll_remittances
  ADD COLUMN IF NOT EXISTS due_date_snapshot date;

-- Backfill from existing due_date
UPDATE public.payroll_remittances
  SET due_date_snapshot = due_date
  WHERE due_date_snapshot IS NULL AND due_date IS NOT NULL;

CREATE OR REPLACE FUNCTION public.snapshot_remittance_due_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.due_date_snapshot IS NULL THEN
    NEW.due_date_snapshot := NEW.due_date;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_snapshot_remittance_due_date ON public.payroll_remittances;
CREATE TRIGGER trg_snapshot_remittance_due_date
  BEFORE INSERT ON public.payroll_remittances
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_remittance_due_date();

-- 3. install_localization_pack_atomic
CREATE OR REPLACE FUNCTION public.install_localization_pack_atomic(
  _business_id uuid,
  _pack_id uuid,
  _installed_by uuid,
  _force_reseed boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org_id uuid;
  _pack record;
  _existing record;
  _taxes_seeded int := 0;
  _accounts_seeded int := 0;
  _payroll_seeded int := 0;
  _payroll_skipped int := 0;
BEGIN
  -- Resolve org from business
  SELECT organization_id INTO _org_id FROM businesses WHERE id = _business_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id USING ERRCODE = 'P0002';
  END IF;

  -- Load pack
  SELECT * INTO _pack FROM localization_packs
    WHERE id = _pack_id AND is_active = true AND is_published = true;
  IF _pack.id IS NULL THEN
    RAISE EXCEPTION 'Localization pack % not found or not published', _pack_id USING ERRCODE = 'P0002';
  END IF;

  -- Check existing
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

  -- Seed tax templates (skip duplicates by name)
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

  -- Seed accounts (skip by code, fix-up parents in second pass)
  WITH inserted AS (
    INSERT INTO accounts (organization_id, business_id, code, name, account_type, description, cash_flow_category, is_system, is_active, opening_balance, current_balance)
    SELECT _org_id, _business_id, a.code, a.name, a.account_type, a.description, a.cash_flow_category, COALESCE(a.is_system, false), true, 0, 0
    FROM localization_pack_account_templates a
    WHERE a.pack_id = _pack_id
      AND NOT EXISTS (
        SELECT 1 FROM accounts ac
        WHERE ac.organization_id = _org_id AND ac.business_id = _business_id AND ac.code = a.code
      )
    RETURNING 1
  )
  SELECT count(*) INTO _accounts_seeded FROM inserted;

  -- Parent fix-up
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

  -- Seed payroll statutory rules (skip duplicates by rule_type+rule_name)
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

  -- Record installation
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
$$;

GRANT EXECUTE ON FUNCTION public.install_localization_pack_atomic(uuid, uuid, uuid, boolean) TO authenticated, service_role;

-- 4. uninstall_localization_pack
CREATE OR REPLACE FUNCTION public.uninstall_localization_pack(
  _business_id uuid,
  _pack_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _run_count int;
  _deleted int;
BEGIN
  SELECT count(*) INTO _run_count FROM payroll_runs WHERE business_id = _business_id;
  -- We cannot tie runs directly to a pack, but if any posted runs exist for the
  -- business we conservatively refuse uninstall to preserve audit reproducibility.
  IF _run_count > 0 THEN
    RAISE EXCEPTION 'Cannot uninstall pack: % payroll run(s) exist for this business', _run_count
      USING ERRCODE = 'restrict_violation';
  END IF;

  DELETE FROM installed_localization_packs
    WHERE business_id = _business_id AND pack_id = _pack_id;
  GET DIAGNOSTICS _deleted = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'removed', _deleted);
END;
$$;

GRANT EXECUTE ON FUNCTION public.uninstall_localization_pack(uuid, uuid) TO authenticated, service_role;

-- 5. promote_pack_version
CREATE OR REPLACE FUNCTION public.promote_pack_version(
  _business_id uuid,
  _pack_id uuid,
  _target_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _updated int;
BEGIN
  UPDATE installed_localization_packs
    SET pack_version = _target_version, installed_at = now()
    WHERE business_id = _business_id AND pack_id = _pack_id;
  GET DIAGNOSTICS _updated = ROW_COUNT;

  IF _updated = 0 THEN
    RAISE EXCEPTION 'No installed pack found for business=% pack=%', _business_id, _pack_id
      USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('success', true, 'pack_version', _target_version);
END;
$$;

GRANT EXECUTE ON FUNCTION public.promote_pack_version(uuid, uuid, text) TO authenticated, service_role;
