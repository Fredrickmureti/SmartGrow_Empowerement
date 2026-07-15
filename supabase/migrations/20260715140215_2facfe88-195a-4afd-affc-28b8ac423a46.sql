
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
      owner_kind, owner_ref, preview_kind, export_formats, parameters, metadata
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
                         'engine','generate-statutory-return')
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
      owner_kind, owner_ref, preview_kind, export_formats, parameters, metadata
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
                         'engine','generate-tax-certificate')
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

CREATE OR REPLACE FUNCTION public._trg_payroll_report_defs_pack_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.payroll_report_definitions_sync_from_packs();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_report_defs_sync_returns ON public.localization_pack_return_templates;
CREATE TRIGGER trg_payroll_report_defs_sync_returns
AFTER INSERT OR UPDATE OR DELETE ON public.localization_pack_return_templates
FOR EACH STATEMENT EXECUTE FUNCTION public._trg_payroll_report_defs_pack_sync();

DROP TRIGGER IF EXISTS trg_payroll_report_defs_sync_certs ON public.localization_pack_certificate_templates;
CREATE TRIGGER trg_payroll_report_defs_sync_certs
AFTER INSERT OR UPDATE OR DELETE ON public.localization_pack_certificate_templates
FOR EACH STATEMENT EXECUTE FUNCTION public._trg_payroll_report_defs_pack_sync();

SELECT public.payroll_report_definitions_sync_from_packs();
