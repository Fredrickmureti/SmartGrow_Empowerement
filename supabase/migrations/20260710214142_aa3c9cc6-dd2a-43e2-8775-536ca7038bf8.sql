CREATE OR REPLACE FUNCTION public.enforce_certificate_template_structure()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _kind         TEXT;
  _sections     JSONB;
  _types        TEXT[];
  _needed_ident TEXT[] := ARRAY['employer_header','employee_header','signature_block'];
  _needed_data  TEXT[] := ARRAY['monthly_breakdown','ytd_table','totals'];
  _missing_ident TEXT[];
  _has_data      BOOLEAN;
  _statutory_re  TEXT := '^(P9|P10|VAT|PAYE|NSSF|SHIF|AHL|WHT|NHIF|NITA|HELB)';
BEGIN
  _kind := COALESCE(NEW.body ->> 'kind',
                    CASE WHEN NEW.body ? 'asset_key' THEN 'xlsx_binary' ELSE 'v2' END);

  IF _kind = 'xlsx_binary' THEN
    IF NOT (NEW.body ? 'asset_key' AND NEW.body ? 'master_sha256' AND NEW.body ? 'cell_bindings') THEN
      RAISE EXCEPTION 'Certificate template % (%): xlsx_binary body must include asset_key, master_sha256, cell_bindings.',
                      NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    _sections := COALESCE(NEW.body -> 'sections', '[]'::jsonb);
    IF jsonb_typeof(_sections) <> 'array' OR jsonb_array_length(_sections) = 0 THEN
      RAISE EXCEPTION 'Certificate template % (%): body.sections must be a non-empty array. Legacy blocks-only templates are no longer publishable.',
                      NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
    END IF;

    SELECT array_agg(elem->>'type') INTO _types FROM jsonb_array_elements(_sections) AS elem;
    SELECT array_agg(needed) INTO _missing_ident FROM unnest(_needed_ident) AS needed WHERE needed <> ALL (_types);

    IF _missing_ident IS NOT NULL AND array_length(_missing_ident, 1) > 0 THEN
      RAISE EXCEPTION 'Certificate template % (%): sections missing required identity/signature types: %. Every section-based certificate must include employer_header, employee_header, and signature_block.',
                      NEW.code, NEW.display_name, array_to_string(_missing_ident, ', ')
        USING ERRCODE = 'check_violation';
    END IF;

    _has_data := EXISTS (SELECT 1 FROM unnest(_needed_data) t WHERE t = ANY (_types));
    IF NOT _has_data THEN
      RAISE EXCEPTION 'Certificate template % (%): must contain at least one data section (monthly_breakdown, ytd_table, or totals).',
                      NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.effective_date IS NULL OR NEW.effective_date < DATE '2000-01-01' THEN
    RAISE EXCEPTION 'Certificate template % (%): effective_date must be set and >= 2000-01-01 (got %).',
                    NEW.code, NEW.display_name, NEW.effective_date USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.code ~ _statutory_re AND NEW.authority_id IS NULL THEN
    RAISE EXCEPTION 'Certificate template % (%): statutory code requires authority_id (link a statutory_authorities row).',
                    NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.legal_reference IS NOT NULL AND NEW.legal_reference <> ''
     AND (NEW.regulation_citation IS NULL OR NEW.regulation_citation = '') THEN
    RAISE EXCEPTION 'Certificate template % (%): regulation_citation is required whenever legal_reference is set.',
                    NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;