
-- Phase 5a: Registry model extensions for the Payroll Reporting Centre.
--
-- Adds four columns that let the viewer dispatch on canonical data source,
-- render a payroll-native period selector, surface lifecycle preconditions,
-- and delegate pack-owned artifacts to their canonical generators.

ALTER TABLE public.payroll_report_definitions
  ADD COLUMN IF NOT EXISTS data_source text NOT NULL DEFAULT 'payroll_engine.payslips',
  ADD COLUMN IF NOT EXISTS period_selector jsonb NOT NULL DEFAULT '{"primary":"custom","allowed":["custom"]}'::jsonb,
  ADD COLUMN IF NOT EXISTS dependencies text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS artifact_generator text;

-- Enum guard for data_source. Kept as a CHECK (not a Postgres enum) so
-- future contributions from packs / new modules stay a one-line migration.
ALTER TABLE public.payroll_report_definitions
  DROP CONSTRAINT IF EXISTS payroll_report_definitions_data_source_chk;
ALTER TABLE public.payroll_report_definitions
  ADD CONSTRAINT payroll_report_definitions_data_source_chk CHECK (data_source IN (
    'payroll_engine.payslips',
    'payroll_engine.payslip_lines',
    'payroll_engine.payroll_liabilities',
    'payroll_engine.payroll_work_entries',
    'finance.journal_entries',
    'pack_artifact.statutory_return',
    'pack_artifact.tax_certificate',
    'remittance.payroll_remittances',
    'audit.payslip_events'
  ));

-- ---------------------------------------------------------------------------
-- Backfill core (non-pack) definitions.
-- ---------------------------------------------------------------------------
UPDATE public.payroll_report_definitions SET
  data_source = 'payroll_engine.payslips',
  period_selector = '{"primary":"run","allowed":["run","month","custom"]}'::jsonb,
  dependencies = ARRAY['payroll_approved']
WHERE report_key IN ('payroll_register','payroll_summary','branch_payroll_cost','department_payroll_cost','employer_contributions');

UPDATE public.payroll_report_definitions SET
  data_source = 'payroll_engine.payroll_liabilities',
  period_selector = '{"primary":"month","allowed":["month","quarter","tax_year","custom"]}'::jsonb,
  dependencies = ARRAY['payroll_approved']
WHERE report_key = 'statutory_liabilities';

UPDATE public.payroll_report_definitions SET
  data_source = 'payroll_engine.payslip_lines',
  preview_kind = 'matrix',
  period_selector = '{"primary":"tax_year","allowed":["tax_year","run","custom"]}'::jsonb,
  dependencies = ARRAY['payroll_approved']
WHERE report_key = 'employee_earnings';

UPDATE public.payroll_report_definitions SET
  data_source = 'payroll_engine.payroll_work_entries',
  period_selector = '{"primary":"run","allowed":["run","month","custom"]}'::jsonb,
  dependencies = ARRAY[]::text[]
WHERE report_key = 'payroll_work_entries';

UPDATE public.payroll_report_definitions SET
  data_source = 'payroll_engine.payslip_lines',
  period_selector = '{"primary":"month","allowed":["month","quarter","custom"]}'::jsonb,
  dependencies = ARRAY['payroll_approved']
WHERE report_key IN ('payroll_overtime','payroll_variance');

UPDATE public.payroll_report_definitions SET
  data_source = 'finance.journal_entries',
  period_selector = '{"primary":"run","allowed":["run","month","custom"]}'::jsonb,
  dependencies = ARRAY['payroll_approved','gl_posted']
WHERE report_key = 'payroll_gl_posting';

UPDATE public.payroll_report_definitions SET
  data_source = 'audit.payslip_events',
  period_selector = '{"primary":"month","allowed":["month","run","custom"]}'::jsonb,
  dependencies = ARRAY[]::text[]
WHERE report_key = 'payroll_audit_trail';

-- ---------------------------------------------------------------------------
-- Update pack sync so future / re-run sync also writes the new columns.
-- Pack returns delegate to `generate-statutory-return`, certificates to
-- `generate-tax-certificate`. Both require an approved payroll run.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_report_definitions_sync_from_packs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_key text;
  v_formats jsonb;
  v_fmt text;
BEGIN
  FOR r IN
    SELECT rt.pack_id, rt.code, rt.display_name, rt.description, rt.period,
           rt.submission_format, rt.sort_order,
           lp.country_code, lp.name AS pack_name, lp.version AS pack_version
      FROM public.localization_pack_return_templates rt
      JOIN public.localization_packs lp ON lp.id = rt.pack_id
  LOOP
    v_key := 'pack_' || lower(coalesce(r.country_code,'xx')) || '_return_' || lower(r.code);
    v_fmt := lower(coalesce(r.submission_format->>'kind',''));
    v_formats := CASE v_fmt
      WHEN 'csv'      THEN '[{"format":"official_csv","label":"Official CSV","isPrimary":true},{"format":"pdf","label":"PDF"}]'::jsonb
      WHEN 'xml'      THEN '[{"format":"xml","label":"Official XML","isPrimary":true},{"format":"pdf","label":"PDF"}]'::jsonb
      WHEN 'gov_xlsx' THEN '[{"format":"xlsx","label":"Official Excel","isPrimary":true},{"format":"pdf","label":"PDF"}]'::jsonb
      WHEN 'pdf'      THEN '[{"format":"pdf","label":"PDF","isPrimary":true}]'::jsonb
      ELSE                 '[{"format":"pdf","label":"PDF","isPrimary":true},{"format":"csv","label":"CSV"}]'::jsonb
    END;

    INSERT INTO public.payroll_report_definitions (
      report_key, label, description, category, scope,
      country_code, localization_pack_id, sort_order, is_active,
      owner_kind, owner_ref, preview_kind, export_formats, parameters, metadata,
      data_source, period_selector, dependencies, artifact_generator
    ) VALUES (
      v_key, r.display_name, r.description, 'compliance', 'organization',
      r.country_code, r.pack_id, 3000 + coalesce(r.sort_order,0), true,
      'localization_pack',
      jsonb_build_object('pack_id', r.pack_id, 'pack_name', r.pack_name,
                         'pack_version', r.pack_version, 'template_code', r.code,
                         'template_kind','return')::text,
      'statutory_form',
      v_formats,
      '{"period":{"required":true,"kind":"period_selector"}}'::jsonb,
      jsonb_build_object('template_code', r.code, 'template_kind','return',
                         'period', r.period, 'submission_format', r.submission_format,
                         'engine','generate-statutory-return'),
      'pack_artifact.statutory_return',
      '{"primary":"month","allowed":["month","quarter","custom"]}'::jsonb,
      ARRAY['payroll_approved']::text[],
      'generate-statutory-return'
    )
    ON CONFLICT (report_key, country_code) DO UPDATE
      SET label            = EXCLUDED.label,
          description      = EXCLUDED.description,
          localization_pack_id = EXCLUDED.localization_pack_id,
          owner_kind       = EXCLUDED.owner_kind,
          owner_ref        = EXCLUDED.owner_ref,
          preview_kind     = EXCLUDED.preview_kind,
          export_formats   = EXCLUDED.export_formats,
          metadata         = EXCLUDED.metadata,
          sort_order       = EXCLUDED.sort_order,
          is_active        = true,
          data_source      = EXCLUDED.data_source,
          period_selector  = EXCLUDED.period_selector,
          dependencies     = EXCLUDED.dependencies,
          artifact_generator = EXCLUDED.artifact_generator,
          updated_at       = now();
  END LOOP;

  FOR r IN
    SELECT ct.pack_id, ct.code, ct.display_name, ct.description, ct.period,
           ct.sort_order, ct.issued_to,
           lp.country_code, lp.name AS pack_name, lp.version AS pack_version
      FROM public.localization_pack_certificate_templates ct
      JOIN public.localization_packs lp ON lp.id = ct.pack_id
  LOOP
    v_key := 'pack_' || lower(coalesce(r.country_code,'xx')) || '_cert_' || lower(r.code);
    INSERT INTO public.payroll_report_definitions (
      report_key, label, description, category, scope,
      country_code, localization_pack_id, sort_order, is_active,
      owner_kind, owner_ref, preview_kind, export_formats, parameters, metadata,
      data_source, period_selector, dependencies, artifact_generator
    ) VALUES (
      v_key, r.display_name, r.description, 'compliance', 'employee',
      r.country_code, r.pack_id, 4000 + coalesce(r.sort_order,0), true,
      'localization_pack',
      jsonb_build_object('pack_id', r.pack_id, 'pack_name', r.pack_name,
                         'pack_version', r.pack_version, 'template_code', r.code,
                         'template_kind','certificate')::text,
      'certificate',
      '[{"format":"pdf","label":"PDF","isPrimary":true},{"format":"xlsx","label":"Excel"}]'::jsonb,
      '{"period":{"required":true,"kind":"period_selector"},"employee":{"required":false,"kind":"employee_selector"}}'::jsonb,
      jsonb_build_object('template_code', r.code, 'template_kind','certificate',
                         'period', r.period, 'issued_to', r.issued_to,
                         'engine','generate-tax-certificate'),
      'pack_artifact.tax_certificate',
      '{"primary":"tax_year","allowed":["tax_year","custom"]}'::jsonb,
      ARRAY['payroll_approved']::text[],
      'generate-tax-certificate'
    )
    ON CONFLICT (report_key, country_code) DO UPDATE
      SET label            = EXCLUDED.label,
          description      = EXCLUDED.description,
          localization_pack_id = EXCLUDED.localization_pack_id,
          owner_kind       = EXCLUDED.owner_kind,
          owner_ref        = EXCLUDED.owner_ref,
          preview_kind     = EXCLUDED.preview_kind,
          export_formats   = EXCLUDED.export_formats,
          metadata         = EXCLUDED.metadata,
          sort_order       = EXCLUDED.sort_order,
          is_active        = true,
          data_source      = EXCLUDED.data_source,
          period_selector  = EXCLUDED.period_selector,
          dependencies     = EXCLUDED.dependencies,
          artifact_generator = EXCLUDED.artifact_generator,
          updated_at       = now();
  END LOOP;

  UPDATE public.payroll_report_definitions d
     SET is_active = false, updated_at = now()
   WHERE d.owner_kind = 'localization_pack'
     AND d.is_active = true
     AND NOT EXISTS (
       SELECT 1 FROM public.localization_pack_return_templates rt
        WHERE rt.pack_id = d.localization_pack_id
          AND rt.code = (d.owner_ref::jsonb->>'template_code')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.localization_pack_certificate_templates ct
        WHERE ct.pack_id = d.localization_pack_id
          AND ct.code = (d.owner_ref::jsonb->>'template_code')
     );
END;
$$;

-- Re-run so already-installed packs pick up the new columns.
SELECT public.payroll_report_definitions_sync_from_packs();

-- ---------------------------------------------------------------------------
-- Lifecycle readiness RPC (Phase 5g scaffolding). Consumed by the library
-- cards and the viewer header so empty results are diagnostic, not silent.
-- Returns a jsonb of { dep_key: 'ready'|'pending'|'unknown' } for a report
-- against a resolved period range.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_report_readiness(
  p_organization_id uuid,
  p_business_id uuid,
  p_report_key text,
  p_date_from date,
  p_date_to date
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deps text[];
  v_out jsonb := '{}'::jsonb;
  v_approved int;
  v_posted int;
BEGIN
  SELECT dependencies INTO v_deps
    FROM public.payroll_report_definitions
   WHERE report_key = p_report_key
   LIMIT 1;

  IF v_deps IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  IF 'payroll_approved' = ANY(v_deps) THEN
    SELECT count(*) INTO v_approved
      FROM public.payroll_runs r
     WHERE r.organization_id = p_organization_id
       AND (p_business_id IS NULL OR r.business_id = p_business_id)
       AND r.approved_at IS NOT NULL
       AND r.pay_period_start <= p_date_to
       AND r.pay_period_end   >= p_date_from;
    v_out := v_out || jsonb_build_object('payroll_approved',
      CASE WHEN v_approved > 0 THEN 'ready' ELSE 'pending' END);
  END IF;

  IF 'gl_posted' = ANY(v_deps) THEN
    SELECT count(*) INTO v_posted
      FROM public.journal_entries je
     WHERE je.organization_id = p_organization_id
       AND (p_business_id IS NULL OR je.business_id = p_business_id)
       AND je.entry_date BETWEEN p_date_from AND p_date_to
       AND je.source_type = 'payroll_run';
    v_out := v_out || jsonb_build_object('gl_posted',
      CASE WHEN v_posted > 0 THEN 'ready' ELSE 'pending' END);
  END IF;

  RETURN v_out;
END;
$$;

GRANT EXECUTE ON FUNCTION public.payroll_report_readiness(uuid, uuid, text, date, date) TO authenticated;
