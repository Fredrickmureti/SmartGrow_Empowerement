-- Tighten certificate template validator: reject any body with schema_version < 3.
-- All 5 existing templates are already v3; this locks the door.
CREATE OR REPLACE FUNCTION public.assert_certificate_template_body_valid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  _schema jsonb;
  _errs text[];
  _v int;
BEGIN
  IF NEW.body IS NULL THEN
    RAISE EXCEPTION 'Certificate template % has NULL body', NEW.code;
  END IF;

  _v := COALESCE((NEW.body->>'schema_version')::int, 1);
  IF _v < 3 THEN
    RAISE EXCEPTION
      'Certificate template % rejected: schema_version=% is below the minimum (3). '
      'The pdf-lib v1/v2 renderers have been retired; author the body as a v3 engine AST.',
      NEW.code, _v;
  END IF;

  SELECT json_schema INTO _schema
  FROM public.pack_rule_type_schemas
  WHERE rule_type='certificate_template' AND computation_kind='v2'
  ORDER BY schema_version DESC LIMIT 1;

  IF _schema IS NULL THEN
    NEW.legacy_unvalidated := true;
    RETURN NEW;
  END IF;

  -- v3 bodies do not carry data_source at root; skip the v2 shape check for them.
  IF _v >= 3 THEN
    NEW.legacy_unvalidated := false;
    RETURN NEW;
  END IF;

  IF NOT (NEW.body ? 'data_source') THEN
    NEW.legacy_unvalidated := true;
    RETURN NEW;
  END IF;

  _errs := public.validate_jsonb_against_schema(NEW.body, _schema);
  IF array_length(_errs,1) > 0 THEN
    RAISE EXCEPTION 'Invalid certificate template body for % : %',
      NEW.code, array_to_string(_errs,'; ');
  END IF;
  NEW.legacy_unvalidated := false;
  RETURN NEW;
END;
$fn$;

-- Verify no row would violate the new rule.
DO $$
DECLARE
  _bad int;
BEGIN
  SELECT COUNT(*) INTO _bad
  FROM public.localization_pack_certificate_templates
  WHERE COALESCE((body->>'schema_version')::int, 1) < 3;
  IF _bad > 0 THEN
    RAISE EXCEPTION 'Cannot tighten validator: % certificate template(s) still on schema_version < 3', _bad;
  END IF;
END $$;