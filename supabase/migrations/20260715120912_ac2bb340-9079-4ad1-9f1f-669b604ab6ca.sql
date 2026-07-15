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
  _has_grid       BOOLEAN;
  _has_field_row  BOOLEAN;
  _is_service_cert BOOLEAN;
  _statutory_re   TEXT := '^(P9|P10|VAT|PAYE|NSSF|SHIF|AHL|WHT|NHIF|NITA|HELB)';
BEGIN
  _schema_ver := COALESCE((NEW.body ->> 'schema_version')::INT, 1);
  _kind := COALESCE(NEW.body ->> 'kind',
                    CASE WHEN NEW.body ? 'asset_key' THEN 'xlsx_binary'
                         WHEN _schema_ver >= 3 THEN 'v3'
                         ELSE 'v2' END);
  _is_service_cert := upper(COALESCE(NEW.code, NEW.body ->> 'code', '')) IN ('CERT_OF_SERVICE','CERTIFICATE_OF_SERVICE')
    OR COALESCE(NEW.display_name, NEW.body ->> 'display_name', '') ~* 'certificate[[:space:]]+of[[:space:]]+service';

  IF _kind = 'xlsx_binary' THEN
    IF NOT (NEW.body ? 'asset_key' AND NEW.body ? 'master_sha256' AND NEW.body ? 'cell_bindings') THEN
      RAISE EXCEPTION 'Certificate template % (%): xlsx_binary body must include asset_key, master_sha256, cell_bindings.',
                      NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
    END IF;
  ELSIF _schema_ver >= 3 THEN
    _document := COALESCE(NEW.body -> 'document', '[]'::jsonb);
    IF jsonb_typeof(_document) <> 'array' OR jsonb_array_length(_document) = 0 THEN
      RAISE EXCEPTION 'Certificate template % (%): v3/v4 body must include a non-empty document array.',
                      NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (NEW.body ? 'paper_format') THEN
      RAISE EXCEPTION 'Certificate template % (%): v3/v4 body must include paper_format.',
                      NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
    END IF;
    SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_document) e WHERE e->>'type' = 'identity_strip')  INTO _has_identity;
    SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_document) e WHERE e->>'type' = 'signature_strip') INTO _has_signature;
    SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_document) e WHERE e->>'type' = 'matrix')          INTO _has_matrix;
    SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_document) e WHERE e->>'type' = 'grid')            INTO _has_grid;
    SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(_document) e WHERE e->>'type' = 'field_row')       INTO _has_field_row;

    IF _schema_ver >= 4 THEN
      IF NOT (_has_identity OR _has_field_row) THEN
        RAISE EXCEPTION 'Certificate template % (%): v4 body must include at least one identity node (identity_strip or field_row).',
                        NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
      END IF;
      IF NOT (_has_matrix OR _has_grid OR _is_service_cert) THEN
        RAISE EXCEPTION 'Certificate template % (%): v4 body must include at least one data node (matrix or grid), except Certificate of Service which is employment-fact based.',
                        NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NOT (_has_identity AND _has_signature) THEN
        RAISE EXCEPTION 'Certificate template % (%): v3 body must include identity_strip and signature_strip nodes.',
                        NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
      END IF;
      IF NOT (_has_matrix OR _is_service_cert) THEN
        RAISE EXCEPTION 'Certificate template % (%): v3 body must include at least one matrix node bound to a period-indexed rows array, except Certificate of Service which is employment-fact based.',
                        NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
      END IF;
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
      IF NOT (_has_data OR _is_service_cert) THEN
        RAISE EXCEPTION 'Certificate template % (%): v2 block body must include at least one table bound to monthly_breakdown, monthly_matrix, or ytd_rows, except Certificate of Service which is employment-fact based.',
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
      IF NOT (_has_data OR _is_service_cert) THEN
        RAISE EXCEPTION 'Certificate template % (%): must contain at least one data section (monthly_breakdown, ytd_table, or totals), except Certificate of Service which is employment-fact based.',
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

DO $$
DECLARE
  _ke_pack uuid := 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid;
  _version text := '10.1.7';
  _version_id uuid;
BEGIN
  INSERT INTO public.pack_versions (
    pack_id,
    version,
    status,
    changelog,
    published_at,
    schema_version
  ) VALUES (
    _ke_pack,
    _version,
    'published',
    jsonb_build_object(
      'source', 'certificate-service-root-fix',
      'summary', 'Certificate of Service now renders from employment service facts instead of a fake payroll matrix, removing the TEMPLATE_STRUCTURAL_INVALID 422 loop.',
      'affected_templates', jsonb_build_array('CERT_OF_SERVICE'),
      'tenant_data_migration_required', false
    ),
    now(),
    1
  )
  ON CONFLICT (pack_id, version) DO UPDATE SET
    status = EXCLUDED.status,
    changelog = EXCLUDED.changelog,
    published_at = COALESCE(public.pack_versions.published_at, EXCLUDED.published_at)
  RETURNING id INTO _version_id;

  UPDATE public.localization_pack_certificate_templates
  SET body = $json$
  {
    "schema_version": 3,
    "code": "CERT_OF_SERVICE",
    "display_name": "Certificate of Service",
    "paper_format": {
      "size": "A4", "orientation": "portrait",
      "margin_top": 22, "margin_right": 20, "margin_bottom": 20, "margin_left": 20,
      "header_height": 20, "footer_height": 10
    },
    "page_master": {
      "code": "generic.cos.page_master.v2",
      "header": [
        { "type":"heading","level":1,"align":"center",
          "text":{"kind":"binding","path":"employer.name","fallback":"EMPLOYER"} },
        { "type":"heading","level":2,"align":"center",
          "text":{"kind":"literal","value":"CERTIFICATE OF SERVICE"} },
        { "type":"rich_text","align":"center",
          "paragraphs":[[{"text":{"kind":"literal","value":"Issued pursuant to Section 51 of the Employment Act, 2007"},"emphasis":"muted"}]] }
      ],
      "footer": [
        { "type":"rich_text","align":"center",
          "paragraphs":[[
            {"text":{"kind":"literal","value":"Serial "},"emphasis":"muted"},
            {"text":{"kind":"binding","path":"serial_number"}},
            {"text":{"kind":"literal","value":"  ·  Issued "},"emphasis":"muted"},
            {"text":{"kind":"binding","path":"generated_at"}}
          ]] }
      ]
    },
    "document": [
      { "type":"identity_strip",
        "left_title":{"kind":"literal","value":"Employer"},
        "right_title":{"kind":"literal","value":"Employee"},
        "left":[
          {"type":"key_value","label":{"kind":"literal","value":"Name"},"value":{"kind":"binding","path":"employer.name"}},
          {"type":"key_value","label":{"kind":"literal","value":"Address"},"value":{"kind":"binding","path":"employer.address"}},
          {"type":"key_value","label":{"kind":"literal","value":"Contact"},"value":{"kind":"binding","path":"employer.phone"}}
        ],
        "right":[
          {"type":"key_value","label":{"kind":"literal","value":"Full Name"},"value":{"kind":"binding","path":"employee.full_name"},"emphasis":"primary"},
          {"type":"key_value","label":{"kind":"literal","value":"National ID"},"value":{"kind":"binding","path":"employee.national_id"}},
          {"type":"key_value","label":{"kind":"literal","value":"Employee No."},"value":{"kind":"binding","path":"employee.employee_number"}}
        ]
      },
      { "type":"spacer","size_mm":4 },
      { "type":"section",
        "title":{"kind":"literal","value":"Service Details"},
        "keep_together":true,
        "children":[
          {"type":"key_value","label":{"kind":"literal","value":"Date of Engagement"},"value":{"kind":"binding","path":"employee.hire_date","format":"date"}},
          {"type":"key_value","label":{"kind":"literal","value":"Date of Exit"},"value":{"kind":"binding","path":"employee.exit_date","format":"date","fallback":"Current"}},
          {"type":"key_value","label":{"kind":"literal","value":"Last Position Held"},"value":{"kind":"binding","path":"employee.position"}},
          {"type":"key_value","label":{"kind":"literal","value":"Department"},"value":{"kind":"binding","path":"employee.department"}}
        ]
      },
      { "type":"spacer","size_mm":4 },
      { "type":"legal_notice",
        "title":{"kind":"literal","value":"Statement"},
        "border":false,
        "paragraphs":[
          {"kind":"literal","value":"This is to certify that the above-named employee served this organisation in the capacity and for the period stated. This certificate is issued in accordance with Section 51 of the Employment Act, 2007, and constitutes a factual record of employment only; it does not comment on conduct or performance."}
        ]
      },
      { "type":"spacer","size_mm":8 },
      { "type":"signature_strip",
        "slots":[
          {"caption":{"kind":"literal","value":"Authorised Signatory"},"sub_caption":{"kind":"literal","value":"Name, Designation, Date & Company Stamp"}}
        ]
      }
    ]
  }
  $json$::jsonb,
      pack_version_id = _version_id,
      updated_at = now(),
      revision_notes = 'v10.1.7: Certificate of Service is employment-fact based; removed fake payroll matrix that caused TEMPLATE_STRUCTURAL_INVALID 422.'
  WHERE pack_id = _ke_pack AND code = 'CERT_OF_SERVICE';

  UPDATE public.localization_packs
  SET version = _version,
      updated_at = now()
  WHERE id = _ke_pack;

  INSERT INTO public.pack_upgrade_proposals (
    organization_id,
    business_id,
    pack_id,
    from_version,
    to_version,
    diff,
    status
  )
  SELECT
    ilp.organization_id,
    ilp.business_id,
    ilp.pack_id,
    ilp.pack_version,
    _version,
    jsonb_build_object(
      'source', 'certificate-service-root-fix',
      'summary', 'Upgrade to generate Certificate of Service without the payroll matrix 422 failure.',
      'affected_templates', jsonb_build_array('CERT_OF_SERVICE'),
      'tenant_data_migration_required', false
    ),
    'pending'
  FROM public.installed_localization_packs ilp
  WHERE ilp.pack_id = _ke_pack
    AND ilp.pack_version <> _version
  ON CONFLICT (organization_id, business_id, pack_id, to_version) DO NOTHING;
END $$;