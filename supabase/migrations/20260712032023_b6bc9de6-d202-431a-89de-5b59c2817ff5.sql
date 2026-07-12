-- ADR-0060 addendum: certificate templates own their page orientation.

UPDATE public.pack_rule_type_schemas
SET json_schema = jsonb_set(
  json_schema,
  '{properties,page}',
  jsonb_build_object(
    'type','object',
    'additionalProperties', false,
    'properties', jsonb_build_object(
      'size',        jsonb_build_object('type','string','enum', jsonb_build_array('a4')),
      'orientation', jsonb_build_object('type','string','enum', jsonb_build_array('portrait','landscape'))
    )
  ),
  true
)
WHERE rule_type = 'certificate_template'
  AND computation_kind = 'v2';

UPDATE public.localization_pack_certificate_templates
SET body = jsonb_set(
  body,
  '{page}',
  jsonb_build_object('size','a4','orientation','landscape'),
  true
)
WHERE code IN ('P9', 'P9A');

INSERT INTO public.pack_audit_log (scope, entity_table, action, metadata)
VALUES (
  'system',
  'localization_pack_certificate_templates',
  'page_orientation_migrated',
  jsonb_build_object(
    'adr', '0060-addendum',
    'change', 'Added optional body.page.{size,orientation}; flipped KE P9/P9A to landscape',
    'rationale', 'KRA official P9 is A4 landscape; 18-column monthly grid overflowed portrait width'
  )
);
