
-- 1. Authority registry (pack-owned)
CREATE TABLE public.statutory_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  country_code text NOT NULL,
  code text NOT NULL,
  display_name text NOT NULL,
  portal_url text,
  efiling_endpoint text,
  contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, country_code, code)
);

GRANT SELECT ON public.statutory_authorities TO authenticated;
GRANT ALL ON public.statutory_authorities TO service_role;

ALTER TABLE public.statutory_authorities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "statutory_authorities_read_authenticated"
  ON public.statutory_authorities FOR SELECT TO authenticated USING (true);

CREATE POLICY "statutory_authorities_platform_admin_manage"
  ON public.statutory_authorities FOR ALL TO authenticated
  USING (is_platform_admin(auth.uid()))
  WITH CHECK (is_platform_admin(auth.uid()));

CREATE POLICY "statutory_authorities_service_role_all"
  ON public.statutory_authorities FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER trg_statutory_authorities_updated_at
  BEFORE UPDATE ON public.statutory_authorities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. First-class metadata columns on return templates
ALTER TABLE public.localization_pack_return_templates
  ADD COLUMN authority_id uuid REFERENCES public.statutory_authorities(id) ON DELETE RESTRICT,
  ADD COLUMN legal_reference text,
  ADD COLUMN regulation_citation text,
  ADD COLUMN effective_date date NOT NULL DEFAULT DATE '1900-01-01',
  ADD COLUMN sunset_date date,
  ADD COLUMN submission_channel text,
  ADD COLUMN digital_signature_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN acknowledgement_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN api_endpoint_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN approval_required boolean NOT NULL DEFAULT false;

-- 3. Backfill authority registry from existing template authority_name values
INSERT INTO public.statutory_authorities (pack_id, country_code, code, display_name)
SELECT DISTINCT
  t.pack_id,
  COALESCE(p.country_code, 'XX') AS country_code,
  regexp_replace(upper(t.authority_name), '[^A-Z0-9]+', '_', 'g') AS code,
  t.authority_name AS display_name
FROM public.localization_pack_return_templates t
LEFT JOIN public.localization_packs p ON p.id = t.pack_id
WHERE t.authority_name IS NOT NULL
  AND t.pack_id IS NOT NULL
ON CONFLICT (pack_id, country_code, code) DO NOTHING;

UPDATE public.localization_pack_return_templates t
SET authority_id = a.id
FROM public.statutory_authorities a, public.localization_packs p
WHERE t.pack_id = a.pack_id
  AND p.id = t.pack_id
  AND a.country_code = COALESCE(p.country_code, 'XX')
  AND a.code = regexp_replace(upper(t.authority_name), '[^A-Z0-9]+', '_', 'g')
  AND t.authority_id IS NULL;

CREATE INDEX idx_return_templates_authority_id ON public.localization_pack_return_templates(authority_id);
CREATE INDEX idx_return_templates_effective_date ON public.localization_pack_return_templates(effective_date);
CREATE INDEX idx_statutory_authorities_pack ON public.statutory_authorities(pack_id);

-- 4. Register lint schema for the new v2 metadata
INSERT INTO public.pack_rule_type_schemas (rule_type, computation_kind, schema_version, json_schema, description)
VALUES (
  'return_template_v2',
  'metadata',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Return Template v2 Metadata',
    'type', 'object',
    'required', jsonb_build_array('authority_id', 'effective_date'),
    'properties', jsonb_build_object(
      'authority_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
      'legal_reference', jsonb_build_object('type', array['string','null']::text[]),
      'regulation_citation', jsonb_build_object('type', array['string','null']::text[]),
      'effective_date', jsonb_build_object('type', 'string', 'format', 'date'),
      'sunset_date', jsonb_build_object('type', array['string','null']::text[], 'format', 'date'),
      'submission_channel', jsonb_build_object('type', array['string','null']::text[]),
      'submission_format', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'kind', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('csv','xlsx','xml','pdf','json')),
          'delimiter', jsonb_build_object('type', array['string','null']::text[]),
          'encoding', jsonb_build_object('type', array['string','null']::text[]),
          'columns', jsonb_build_object('type', 'array')
        )
      ),
      'digital_signature_spec', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'method', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('none','hash','pkcs7','xades','jws')),
          'cert_authority', jsonb_build_object('type', array['string','null']::text[]),
          'hash_alg', jsonb_build_object('type', array['string','null']::text[])
        )
      ),
      'acknowledgement_spec', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'mode', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('sync','async','none')),
          'envelope_schema', jsonb_build_object('type', array['string','null']::text[])
        )
      ),
      'api_endpoint_spec', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'url_template', jsonb_build_object('type', array['string','null']::text[]),
          'auth_scheme', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('none','basic','bearer','oauth2','mtls')),
          'payload_schema_ref', jsonb_build_object('type', array['string','null']::text[])
        )
      ),
      'approval_required', jsonb_build_object('type', 'boolean')
    )
  ),
  'Validates first-class metadata on localization_pack_return_templates (Slice A).'
)
ON CONFLICT DO NOTHING;
