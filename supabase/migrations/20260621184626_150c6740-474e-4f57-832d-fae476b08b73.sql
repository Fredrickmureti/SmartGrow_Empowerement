
-- =====================================================================
-- H1: Pack-driven bank disbursement export templates
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.localization_pack_bank_export_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  format_code text NOT NULL,
  display_name text NOT NULL,
  country_code text,
  file_extension text NOT NULL DEFAULT 'csv',
  mime_type text NOT NULL DEFAULT 'text/csv;charset=utf-8',
  builder_kind text NOT NULL DEFAULT 'csv_columns'
    CHECK (builder_kind IN ('csv_columns','fixed_width','xml')),
  spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, format_code)
);

GRANT SELECT ON public.localization_pack_bank_export_templates TO authenticated;
GRANT ALL ON public.localization_pack_bank_export_templates TO service_role;

ALTER TABLE public.localization_pack_bank_export_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bank_export_templates_read_all_auth"
  ON public.localization_pack_bank_export_templates
  FOR SELECT TO authenticated
  USING (is_active = true);

CREATE POLICY "bank_export_templates_admin_write"
  ON public.localization_pack_bank_export_templates
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_bank_export_templates_updated_at
  BEFORE UPDATE ON public.localization_pack_bank_export_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed: platform-default generic CSV (no pack_id)
INSERT INTO public.localization_pack_bank_export_templates
  (pack_id, format_code, display_name, country_code, file_extension, mime_type, builder_kind, spec)
VALUES (
  NULL,
  'generic',
  'Generic CSV (wide)',
  NULL,
  'csv',
  'text/csv;charset=utf-8',
  'csv_columns',
  jsonb_build_object(
    'delimiter', ',',
    'line_ending', 'CRLF',
    'include_header', true,
    'reference_template', '{batch_number}-{employee_number}',
    'narration_template', 'Salary {payment_date}',
    'columns', jsonb_build_array(
      jsonb_build_object('header','employee_number','source','employee_number'),
      jsonb_build_object('header','first_name','source','first_name'),
      jsonb_build_object('header','last_name','source','last_name'),
      jsonb_build_object('header','bank_name','source','bank_name'),
      jsonb_build_object('header','bank_branch','source','bank_branch'),
      jsonb_build_object('header','bank_code','source','bank_code'),
      jsonb_build_object('header','account_number','source','bank_account_number'),
      jsonb_build_object('header','amount','source','amount','format','money2'),
      jsonb_build_object('header','currency','source','currency'),
      jsonb_build_object('header','reference','source','reference_template'),
      jsonb_build_object('header','narration','source','narration_template')
    )
  )
)
ON CONFLICT DO NOTHING;

-- Seed: Kenyan Pesalink (linked to active KE pack if any)
INSERT INTO public.localization_pack_bank_export_templates
  (pack_id, format_code, display_name, country_code, file_extension, mime_type, builder_kind, spec)
SELECT
  p.id,
  'pesalink',
  'Pesalink Bulk CSV',
  'KE',
  'csv',
  'text/csv;charset=utf-8',
  'csv_columns',
  jsonb_build_object(
    'delimiter', ',',
    'line_ending', 'CRLF',
    'include_header', true,
    'reference_template', '{batch_number}-{employee_number}',
    'narration_template', 'Salary {payment_date}',
    'columns', jsonb_build_array(
      jsonb_build_object('header','BeneficiaryName','source','full_name'),
      jsonb_build_object('header','BankCode','source','bank_code_split','part','bank'),
      jsonb_build_object('header','BranchCode','source','bank_code_split','part','branch'),
      jsonb_build_object('header','AccountNumber','source','bank_account_number'),
      jsonb_build_object('header','Amount','source','amount','format','money2'),
      jsonb_build_object('header','Currency','source','currency'),
      jsonb_build_object('header','Reference','source','reference_template'),
      jsonb_build_object('header','Narration','source','narration_template')
    )
  )
FROM public.localization_packs p
WHERE p.country_code = 'KE' AND p.is_active = true
LIMIT 1
ON CONFLICT DO NOTHING;

-- =====================================================================
-- H2: Pack maturity flag + install gate
-- =====================================================================
ALTER TABLE public.localization_packs
  ADD COLUMN IF NOT EXISTS maturity text NOT NULL DEFAULT 'skeleton'
    CHECK (maturity IN ('skeleton','beta','stable'));

-- Promote KE to stable; others remain skeleton.
UPDATE public.localization_packs SET maturity='stable' WHERE country_code='KE';

-- Gate function: returns jsonb describing whether install is allowed.
-- Edge function calls this BEFORE install_localization_pack_atomic so the
-- existing 4-arg RPC signature stays untouched (no breaking change for
-- typegen or other callers).
CREATE OR REPLACE FUNCTION public.check_pack_install_allowed(
  _pack_id uuid,
  _acknowledge_skeleton boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_maturity text;
  v_rule_count int;
  v_account_count int;
  v_return_count int;
BEGIN
  SELECT maturity INTO v_maturity
    FROM public.localization_packs WHERE id = _pack_id;
  IF v_maturity IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pack_not_found');
  END IF;

  IF v_maturity <> 'skeleton' OR _acknowledge_skeleton THEN
    RETURN jsonb_build_object('ok', true, 'maturity', v_maturity);
  END IF;

  SELECT count(*) INTO v_rule_count
    FROM public.localization_pack_payroll_templates WHERE pack_id = _pack_id;
  SELECT count(*) INTO v_account_count
    FROM public.localization_pack_account_templates WHERE pack_id = _pack_id;
  SELECT count(*) INTO v_return_count
    FROM public.localization_pack_return_templates WHERE pack_id = _pack_id;

  RETURN jsonb_build_object(
    'ok', false,
    'reason', 'pack_is_skeleton',
    'maturity', v_maturity,
    'template_counts', jsonb_build_object(
      'payroll_rules', v_rule_count,
      'accounts', v_account_count,
      'returns', v_return_count
    ),
    'message',
      'This localization pack is marked skeleton and is not production-ready. '
      || 'Pass acknowledge_skeleton=true to install anyway.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_pack_install_allowed(uuid, boolean) TO authenticated, service_role;

-- =====================================================================
-- H3: Pack upgrade rollback
-- =====================================================================
ALTER TABLE public.pack_migration_log
  ADD COLUMN IF NOT EXISTS rolled_back_at timestamptz,
  ADD COLUMN IF NOT EXISTS rolled_back_by uuid,
  ADD COLUMN IF NOT EXISTS rollback_reason text;

CREATE INDEX IF NOT EXISTS pack_migration_log_rollback_idx
  ON public.pack_migration_log (organization_id, business_id, pack_id, pack_version)
  WHERE rolled_back_at IS NULL;

-- RPC: rolls back every not-yet-rolled-back migration row for the given
-- org/business/pack/version by restoring before_value into the live
-- payroll_statutory_rules. Skips rows where the tenant has edited the
-- rule since the upgrade (recorded in pack_rule_conflicts as
-- rollback_blocked).
CREATE OR REPLACE FUNCTION public.rollback_pack_upgrade_atomic(
  _organization_id uuid,
  _business_id uuid,
  _pack_id uuid,
  _from_version text,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_log RECORD;
  v_current_updated timestamptz;
  v_rolled_back int := 0;
  v_blocked int := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'rollback_pack_upgrade_atomic: not authenticated'
      USING ERRCODE = '42501';
  END IF;

  -- Authorization: caller must belong to the org.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = v_actor
      AND uba.business_id = _business_id
  ) THEN
    RAISE EXCEPTION 'rollback_pack_upgrade_atomic: not a member of business %', _business_id
      USING ERRCODE = '42501';
  END IF;

  FOR v_log IN
    SELECT *
    FROM public.pack_migration_log
    WHERE organization_id = _organization_id
      AND business_id     = _business_id
      AND pack_id         = _pack_id
      AND pack_version    = _from_version
      AND rolled_back_at IS NULL
      AND entity_table = 'payroll_statutory_rules'
    ORDER BY created_at DESC
  LOOP
    -- Tenant-edit guard: skip if current row was updated after this log entry.
    SELECT updated_at INTO v_current_updated
      FROM public.payroll_statutory_rules
      WHERE id = v_log.entity_id;

    IF v_current_updated IS NOT NULL AND v_current_updated > v_log.created_at THEN
      INSERT INTO public.pack_rule_conflicts
        (organization_id, business_id, pack_id, pack_version,
         entity_table, entity_id, status, reason, details, created_at)
      VALUES
        (_organization_id, _business_id, _pack_id, _from_version,
         v_log.entity_table, v_log.entity_id,
         'rollback_blocked',
         'tenant_edit_after_upgrade',
         jsonb_build_object(
           'log_id', v_log.id,
           'log_created_at', v_log.created_at,
           'rule_updated_at', v_current_updated
         ),
         now());
      v_blocked := v_blocked + 1;
      CONTINUE;
    END IF;

    -- Restore: if before_value is NULL the upgrade inserted this row; delete it.
    IF v_log.before_value IS NULL THEN
      DELETE FROM public.payroll_statutory_rules WHERE id = v_log.entity_id;
    ELSE
      -- Re-insert or update from the snapshot.
      INSERT INTO public.payroll_statutory_rules
      SELECT * FROM jsonb_populate_record(NULL::public.payroll_statutory_rules, v_log.before_value)
      ON CONFLICT (id) DO UPDATE
        SET rule_code        = EXCLUDED.rule_code,
            parameters       = EXCLUDED.parameters,
            computation_method = EXCLUDED.computation_method,
            updated_at       = now();
    END IF;

    UPDATE public.pack_migration_log
      SET rolled_back_at = now(),
          rolled_back_by = v_actor,
          rollback_reason = _reason
      WHERE id = v_log.id;

    v_rolled_back := v_rolled_back + 1;
  END LOOP;

  -- Bookkeeping: drop installed_localization_packs.pack_version back one step
  -- only if it is still pointing at the version we just rolled back.
  UPDATE public.installed_localization_packs
    SET pack_version = (
      SELECT pack_version
      FROM public.pack_migration_log
      WHERE organization_id = _organization_id
        AND business_id     = _business_id
        AND pack_id         = _pack_id
        AND pack_version   <> _from_version
      ORDER BY created_at DESC
      LIMIT 1
    )
    WHERE organization_id = _organization_id
      AND business_id     = _business_id
      AND pack_id         = _pack_id
      AND pack_version    = _from_version;

  RETURN jsonb_build_object(
    'ok', true,
    'rolled_back_count', v_rolled_back,
    'blocked_count', v_blocked,
    'from_version', _from_version
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rollback_pack_upgrade_atomic(uuid, uuid, uuid, text, text)
  TO authenticated, service_role;
