
-- 1. Register a permissive JSON schema for certificate_template v3 bodies.
INSERT INTO public.pack_rule_type_schemas (rule_type, computation_kind, schema_version, json_schema, description)
VALUES (
  'certificate_template',
  'v3',
  1,
  $schema$
  {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["schema_version", "paper_format", "document"],
    "properties": {
      "schema_version": { "type": "integer", "const": 3 },
      "code":           { "type": "string" },
      "display_name":   { "type": "string" },
      "paper_format": {
        "type": "object",
        "required": ["size","orientation","margin_top","margin_right","margin_bottom","margin_left"],
        "properties": {
          "size":           { "type": "string", "enum": ["A4","A3","Letter","Legal"] },
          "orientation":    { "type": "string", "enum": ["portrait","landscape"] },
          "margin_top":     { "type": "number" },
          "margin_right":   { "type": "number" },
          "margin_bottom":  { "type": "number" },
          "margin_left":    { "type": "number" },
          "header_height":  { "type": "number" },
          "footer_height":  { "type": "number" }
        }
      },
      "page_master": { "type": "object" },
      "document":    { "type": "array", "minItems": 1 }
    }
  }
  $schema$::jsonb,
  'Certificate Engine v3 AST body — country-agnostic paged-media document.'
)
ON CONFLICT (rule_type, computation_kind, schema_version) DO UPDATE
  SET json_schema = EXCLUDED.json_schema,
      description = EXCLUDED.description;

-- 2. Extend the JSON-schema-driven validator to recognize v3 bodies.
CREATE OR REPLACE FUNCTION public.assert_certificate_template_body_valid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  _kind   TEXT;
  _schema JSONB;
  _errs   TEXT[];
  _sv     INT;
BEGIN
  _sv := COALESCE((NEW.body ->> 'schema_version')::INT, 1);
  _kind := COALESCE(
    NEW.body ->> 'kind',
    CASE
      WHEN NEW.body ? 'asset_key' THEN 'xlsx_binary'
      WHEN _sv >= 3               THEN 'v3'
      ELSE                             'v2'
    END
  );

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
$function$;
