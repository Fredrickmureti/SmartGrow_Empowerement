-- 1. Binary asset store attached to pack versions
CREATE TABLE IF NOT EXISTS public.localization_pack_binary_assets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pack_id UUID NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  pack_version_id UUID REFERENCES public.pack_versions(id) ON DELETE CASCADE,
  asset_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  bytes BYTEA NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pack_version_id, asset_key)
);

GRANT SELECT ON public.localization_pack_binary_assets TO authenticated;
GRANT ALL ON public.localization_pack_binary_assets TO service_role;

ALTER TABLE public.localization_pack_binary_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read pack binary assets"
  ON public.localization_pack_binary_assets FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Platform admins manage pack binary assets"
  ON public.localization_pack_binary_assets FOR ALL
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid() AND pa.is_active))
  WITH CHECK (EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid() AND pa.is_active));

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_localization_pack_binary_assets_updated_at ON public.localization_pack_binary_assets;
CREATE TRIGGER trg_localization_pack_binary_assets_updated_at
  BEFORE UPDATE ON public.localization_pack_binary_assets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Track XLSX artefact path alongside PDF
ALTER TABLE public.payroll_tax_certificates
  ADD COLUMN IF NOT EXISTS xlsx_path TEXT;

-- 3. Register the xlsx_binary rule-type schema
INSERT INTO public.pack_rule_type_schemas (rule_type, computation_kind, schema_version, json_schema, ui_schema, token_outputs, description)
VALUES (
  'certificate_template',
  'xlsx_binary',
  1,
  jsonb_build_object(
    '$schema','http://json-schema.org/draft-07/schema#',
    'title','Certificate template — binary (XLSX) master',
    'type','object',
    'required', jsonb_build_array('data_source','asset_key','master_sha256','output','cell_bindings'),
    'additionalProperties', true,
    'properties', jsonb_build_object(
      'data_source', jsonb_build_object('type','string','enum',jsonb_build_array('payroll_ytd','payroll_period')),
      'asset_key',   jsonb_build_object('type','string','minLength',1),
      'master_sha256', jsonb_build_object('type','string','pattern','^[a-f0-9]{64}$'),
      'output',      jsonb_build_object('type','array','minItems',1,'items', jsonb_build_object('type','string','enum',jsonb_build_array('xlsx','pdf'))),
      'sheet',       jsonb_build_object('type','string'),
      'cell_bindings', jsonb_build_object(
        'type','array',
        'items', jsonb_build_object(
          'type','object',
          'required', jsonb_build_array('cell','source'),
          'properties', jsonb_build_object(
            'cell',   jsonb_build_object('type','string','pattern','^[A-Z]+[0-9]+$'),
            'sheet',  jsonb_build_object('type','string'),
            'source', jsonb_build_object('type','string','minLength',1),
            'format', jsonb_build_object('type','string'),
            'kind',   jsonb_build_object('type','string','enum',jsonb_build_array('token','literal','monthly_rule','ytd_rule','derived'))
          )
        )
      ),
      'monthly_grid', jsonb_build_object(
        'type','object',
        'required', jsonb_build_array('start_row','columns'),
        'properties', jsonb_build_object(
          'sheet',      jsonb_build_object('type','string'),
          'start_row',  jsonb_build_object('type','integer','minimum',1),
          'end_row',    jsonb_build_object('type','integer'),
          'month_column', jsonb_build_object('type','string'),
          'columns', jsonb_build_object(
            'type','array',
            'items', jsonb_build_object(
              'type','object',
              'required', jsonb_build_array('column','rule_code'),
              'properties', jsonb_build_object(
                'column',    jsonb_build_object('type','string'),
                'rule_code', jsonb_build_object('type','string'),
                'aggregator',jsonb_build_object('type','string','enum',jsonb_build_array('sum','last','max')),
                'format',    jsonb_build_object('type','string')
              )
            )
          )
        )
      )
    )
  ),
  NULL,
  '[]'::jsonb,
  'Binary XLSX master with cell-level bindings sourced from payroll tokens and payslip rule codes.'
)
ON CONFLICT DO NOTHING;

-- 4. Extend the certificate-body validation trigger to accept xlsx_binary
CREATE OR REPLACE FUNCTION public.assert_certificate_template_body_valid()
RETURNS TRIGGER AS $$
DECLARE
  _kind TEXT;
  _schema JSONB;
  _errs TEXT[];
BEGIN
  -- resolve computation kind on the row (fallback to v2 for legacy rows)
  _kind := COALESCE(NEW.body ->> 'kind',
                    CASE WHEN NEW.body ? 'asset_key' THEN 'xlsx_binary' ELSE 'v2' END);

  SELECT json_schema INTO _schema
  FROM public.pack_rule_type_schemas
  WHERE rule_type = 'certificate_template' AND computation_kind = _kind
  ORDER BY schema_version DESC
  LIMIT 1;

  IF _schema IS NULL THEN
    RAISE EXCEPTION 'No JSON schema registered for certificate_template.%', _kind;
  END IF;

  IF NEW.body IS NULL THEN
    RAISE EXCEPTION 'Certificate template body cannot be null';
  END IF;

  IF _kind = 'v2' AND NOT (NEW.body ? 'data_source') THEN
    RAISE EXCEPTION 'Certificate template v2 body must include data_source';
  END IF;

  IF _kind = 'xlsx_binary' THEN
    IF NOT (NEW.body ? 'asset_key' AND NEW.body ? 'master_sha256' AND NEW.body ? 'cell_bindings') THEN
      RAISE EXCEPTION 'xlsx_binary certificate body must include asset_key, master_sha256, cell_bindings';
    END IF;
  END IF;

  _errs := public.validate_jsonb_against_schema(NEW.body, _schema);
  IF array_length(_errs, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid certificate template body for %: %', NEW.code, array_to_string(_errs, '; ');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;