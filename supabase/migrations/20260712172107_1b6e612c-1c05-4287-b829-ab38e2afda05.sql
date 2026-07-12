
CREATE OR REPLACE FUNCTION public.enforce_certificate_template_structure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  _kind           TEXT;
  _schema_ver     INT;
  _sections       JSONB;
  _blocks         JSONB;
  _document       JSONB;
  _types          TEXT[];
  _needed_ident   TEXT[] := ARRAY['employer_header','employee_header','signature_block'];
  _needed_data    TEXT[] := ARRAY['monthly_breakdown','ytd_table','totals'];
  _missing_ident  TEXT[];
  _has_data       BOOLEAN;
  _has_employer   BOOLEAN;
  _has_employee   BOOLEAN;
  _has_signature  BOOLEAN;
  _has_identity   BOOLEAN;
  _has_matrix     BOOLEAN;
  _statutory_re   TEXT := '^(P9|P10|VAT|PAYE|NSSF|SHIF|AHL|WHT|NHIF|NITA|HELB)';
BEGIN
  _schema_ver := COALESCE((NEW.body ->> 'schema_version')::INT, 1);
  _kind := COALESCE(NEW.body ->> 'kind',
                    CASE WHEN NEW.body ? 'asset_key' THEN 'xlsx_binary'
                         WHEN _schema_ver >= 3 THEN 'v3'
                         ELSE 'v2' END);

  IF _kind = 'xlsx_binary' THEN
    IF NOT (NEW.body ? 'asset_key' AND NEW.body ? 'master_sha256' AND NEW.body ? 'cell_bindings') THEN
      RAISE EXCEPTION 'Certificate template % (%): xlsx_binary body must include asset_key, master_sha256, cell_bindings.',
                      NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
    END IF;
  ELSIF _schema_ver >= 3 THEN
    _document := COALESCE(NEW.body -> 'document', '[]'::jsonb);
    IF jsonb_typeof(_document) <> 'array' OR jsonb_array_length(_document) = 0 THEN
      RAISE EXCEPTION 'Certificate template % (%): v3 body must include a non-empty document array.',
                      NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (NEW.body ? 'paper_format') THEN
      RAISE EXCEPTION 'Certificate template % (%): v3 body must include paper_format.',
                      NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
    END IF;
    SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_document) e WHERE e->>'type' = 'identity_strip')  INTO _has_identity;
    SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_document) e WHERE e->>'type' = 'signature_strip') INTO _has_signature;
    SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_document) e WHERE e->>'type' = 'matrix')          INTO _has_matrix;
    IF NOT (_has_identity AND _has_signature) THEN
      RAISE EXCEPTION 'Certificate template % (%): v3 body must include identity_strip and signature_strip nodes.',
                      NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
    END IF;
    IF NOT _has_matrix THEN
      RAISE EXCEPTION 'Certificate template % (%): v3 body must include at least one matrix node bound to a period-indexed rows array.',
                      NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    _blocks := COALESCE(NEW.body -> 'blocks', '[]'::jsonb);
    IF jsonb_typeof(_blocks) = 'array' AND jsonb_array_length(_blocks) > 0 THEN
      SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_blocks) elem WHERE elem->>'type' = 'field_grid' AND elem->>'data_source' = 'employer') INTO _has_employer;
      SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_blocks) elem WHERE elem->>'type' = 'field_grid' AND elem->>'data_source' = 'employee') INTO _has_employee;
      SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_blocks) elem WHERE elem->>'type' = 'signature_block') INTO _has_signature;
      SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_blocks) elem WHERE elem->>'type' = 'table' AND COALESCE(elem->>'data_source','') IN ('monthly_breakdown','monthly_matrix','ytd_rows')) INTO _has_data;

      IF NOT (_has_employer AND _has_employee AND _has_signature) THEN
        RAISE EXCEPTION 'Certificate template % (%): v2 block body must include employer field_grid, employee field_grid, and signature_block.',
                        NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
      END IF;
      IF NOT _has_data THEN
        RAISE EXCEPTION 'Certificate template % (%): v2 block body must include at least one table bound to monthly_breakdown, monthly_matrix, or ytd_rows.',
                        NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      _sections := COALESCE(NEW.body -> 'sections', '[]'::jsonb);
      IF jsonb_typeof(_sections) <> 'array' OR jsonb_array_length(_sections) = 0 THEN
        RAISE EXCEPTION 'Certificate template % (%): body.sections or body.blocks must be a non-empty array.',
                        NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
      END IF;

      SELECT array_agg(elem->>'type') INTO _types FROM jsonb_array_elements(_sections) AS elem;
      SELECT array_agg(needed) INTO _missing_ident FROM unnest(_needed_ident) AS needed WHERE needed <> ALL (_types);

      IF _missing_ident IS NOT NULL AND array_length(_missing_ident, 1) > 0 THEN
        RAISE EXCEPTION 'Certificate template % (%): sections missing required identity/signature types: %.',
                        NEW.code, NEW.display_name, array_to_string(_missing_ident, ', ')
          USING ERRCODE = 'check_violation';
      END IF;

      _has_data := EXISTS (SELECT 1 FROM unnest(_needed_data) t WHERE t = ANY (_types));
      IF NOT _has_data THEN
        RAISE EXCEPTION 'Certificate template % (%): must contain at least one data section (monthly_breakdown, ytd_table, or totals).',
                        NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.effective_date IS NULL OR NEW.effective_date < DATE '2000-01-01' THEN
    RAISE EXCEPTION 'Certificate template % (%): effective_date must be set and >= 2000-01-01 (got %).',
                    NEW.code, NEW.display_name, NEW.effective_date USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.code ~ _statutory_re AND NEW.authority_id IS NULL THEN
    RAISE EXCEPTION 'Certificate template % (%): statutory code requires authority_id.',
                    NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.legal_reference IS NOT NULL AND NEW.legal_reference <> ''
     AND (NEW.regulation_citation IS NULL OR NEW.regulation_citation = '') THEN
    RAISE EXCEPTION 'Certificate template % (%): regulation_citation is required whenever legal_reference is set.',
                    NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$function$;
