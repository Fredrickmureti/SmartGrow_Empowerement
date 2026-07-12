-- ADR-0061 — Retire the legacy `xlsx_binary` certificate path.
DELETE FROM public.format_registry WHERE format = 'xlsx_binary';

DELETE FROM public.pack_rule_type_schemas WHERE rule_type = 'xlsx_binary';

DROP TABLE IF EXISTS public.localization_pack_binary_assets CASCADE;

INSERT INTO public.pack_audit_log (scope, entity_table, action, metadata, created_at)
VALUES (
  'platform',
  'format_registry',
  'binary_certificate_path_retired',
  jsonb_build_object(
    'adr', '0061',
    'note', 'xlsx_binary rendering, hydrate-localization-binary-asset edge function, and localization_pack_binary_assets table removed. All certificates now render via certificate_template_v2 (structured PDF + optional editable xlsx twin from the same v2 sections). The unused localization-assets storage bucket must be deleted from the Storage UI.'
  ),
  now()
);