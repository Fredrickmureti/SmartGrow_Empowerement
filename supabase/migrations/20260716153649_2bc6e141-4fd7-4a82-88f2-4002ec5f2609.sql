
-- Migration: retire legacy `renderer:"v2-returns"` section pipeline.
-- Idempotent — filters on `body ? 'renderer' OR body ? 'sections'`.

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Pack-level return templates
  FOR r IN
    SELECT id, pack_id, body
    FROM public.localization_pack_return_templates
    WHERE (body ? 'renderer') OR (body ? 'sections')
  LOOP
    INSERT INTO public.pack_audit_log
      (scope, action, entity_table, entity_id, pack_id, before, after, metadata)
    VALUES (
      'platform',
      'retire_v2_returns_renderer',
      'localization_pack_return_templates',
      r.id,
      r.pack_id,
      r.body,
      (r.body - 'renderer' - 'sections'),
      jsonb_build_object('adr', '0063', 'note', 'Section-based PDF renderer retired; tabular renderer used server-side.')
    );

    UPDATE public.localization_pack_return_templates
    SET body = (body - 'renderer' - 'sections')
    WHERE id = r.id;
  END LOOP;

  -- Tenant overrides
  FOR r IN
    SELECT id, body
    FROM public.payroll_return_template_overrides
    WHERE (body ? 'renderer') OR (body ? 'sections')
  LOOP
    INSERT INTO public.pack_audit_log
      (scope, action, entity_table, entity_id, before, after, metadata)
    VALUES (
      'tenant',
      'retire_v2_returns_renderer',
      'payroll_return_template_overrides',
      r.id,
      r.body,
      (r.body - 'renderer' - 'sections'),
      jsonb_build_object('adr', '0063', 'note', 'Section-based PDF renderer retired; tabular renderer used server-side.')
    );

    UPDATE public.payroll_return_template_overrides
    SET body = (body - 'renderer' - 'sections')
    WHERE id = r.id;
  END LOOP;
END $$;
