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
      IF NOT (_has_matrix OR _has_grid) THEN
        RAISE EXCEPTION 'Certificate template % (%): v4 body must include at least one data node (matrix or grid).',
                        NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NOT (_has_identity AND _has_signature) THEN
        RAISE EXCEPTION 'Certificate template % (%): v3 body must include identity_strip and signature_strip nodes.',
                        NEW.code, NEW.display_name USING ERRCODE = 'check_violation';
      END IF;
      IF NOT _has_matrix THEN
        RAISE EXCEPTION 'Certificate template % (%): v3 body must include at least one matrix node bound to a period-indexed rows array.',
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

UPDATE public.localization_pack_certificate_templates
SET body = '{"schema_version":4,"code":"P9","display_name":"Kenya — Tax Deduction Card (P9)","theme":{"body_font":"\"Times New Roman\", \"Nimbus Roman\", Times, serif","heading_font":"\"Helvetica Neue\", \"Arial\", sans-serif","base_font_size_pt":8.5,"color":"#000","muted_color":"#000","rule_color":"#000","rule_weight_pt":0.75,"header_shade":"none","header_letter_shade":"none","header_unit_shade":"none","header_note_shade":"none","zebra":"none","heading_case":"none","heading_underline":false,"grid_font_size_pt":6.5,"grid_number_font_size_pt":6.5,"grid_footer_font_size_pt":6.5,"numeric_letter_spacing":"0","legal_border":false,"legal_border_color":"#000"},"paper_format":{"size":"A4","orientation":"landscape","margin_top":14,"margin_right":10,"margin_bottom":10,"margin_left":10,"header_height":22,"footer_height":8},"page_master":{"code":"ke.p9.page_master.v11","header":[{"type":"field_row","gap_mm":8,"columns":["25mm","1fr","40mm"],"fields":[]},{"type":"columns","count":3,"gap_mm":4,"column_children":[[{"type":"rich_text","align":"left","paragraphs":[[{"text":{"kind":"literal","value":"APPENDIX 2A"},"emphasis":"bold"}]]}],[{"type":"heading","level":2,"align":"center","text":{"kind":"literal","value":"KENYA REVENUE AUTHORITY DOMESTIC TAXES DEPARTMENT"}},{"type":"rich_text","align":"center","paragraphs":[[{"text":{"kind":"literal","value":"TAX DEDUCTION CARD"},"emphasis":"bold"}]]},{"type":"rich_text","align":"center","paragraphs":[[{"text":{"kind":"literal","value":"YEAR "},"emphasis":"muted"},{"text":{"kind":"binding","path":"fiscal_year","fallback":"20 ......"}}]]}],[{"type":"rich_text","align":"right","paragraphs":[[{"text":{"kind":"literal","value":"ISO 9001:2015 CERTIFIED"},"emphasis":"muted"}]]}]]}],"footer":[{"type":"rich_text","align":"center","paragraphs":[[{"text":{"kind":"literal","value":"Serial "},"emphasis":"muted"},{"text":{"kind":"binding","path":"serial_number","fallback":""}},{"text":{"kind":"literal","value":"  ·  Generated "},"emphasis":"muted"},{"text":{"kind":"binding","path":"generated_at","fallback":""}}]]}]},"document":[{"type":"field_row","gap_mm":6,"columns":["1fr","0.6fr"],"fields":[{"type":"label_fill","label":{"kind":"literal","value":"Employer''s Name"},"value":{"kind":"binding","path":"employer.name","fallback":""},"rule":"dotted","label_bold":true},{"type":"label_fill","label":{"kind":"literal","value":"Employer''s PIN"},"value":{"kind":"binding","path":"employer.tax_pin","fallback":""},"rule":"dotted","label_bold":true,"emphasis":"primary"}]},{"type":"field_row","gap_mm":6,"columns":["1fr","0.6fr"],"fields":[{"type":"label_fill","label":{"kind":"literal","value":"Employee''s Main Name"},"value":{"kind":"binding","path":"employee.full_name","fallback":""},"rule":"dotted","label_bold":true},{"type":"label_fill","label":{"kind":"literal","value":"Employee''s PIN"},"value":{"kind":"binding","path":"employee.tax_pin","fallback":""},"rule":"dotted","label_bold":true,"emphasis":"primary"}]},{"type":"field_row","gap_mm":6,"columns":["1fr"],"fields":[{"type":"label_fill","label":{"kind":"literal","value":"Employee''s Other Names"},"value":{"kind":"binding","path":"employee.other_names","fallback":""},"rule":"dotted","label_bold":true}]},{"type":"spacer","size_mm":2},{"type":"grid","columns":[{"id":"month","width":"18mm","align":"left","format":"month_short","nowrap":true},{"id":"col_a","width":"1fr","align":"right","format":"number","source_key":"basic"},{"id":"col_b","width":"1fr","align":"right","format":"number","source_key":"non_cash_benefits"},{"id":"col_c","width":"1fr","align":"right","format":"number","source_key":"housing_benefit"},{"id":"col_d","width":"1fr","align":"right","format":"number"},{"id":"col_e1","width":"1fr","align":"right","format":"number"},{"id":"col_e2","width":"1fr","align":"right","format":"number","source_key":"nssf"},{"id":"col_e3","width":"1fr","align":"right","format":"number"},{"id":"col_f","width":"1fr","align":"right","format":"number","source_key":"housing_levy"},{"id":"col_g","width":"1fr","align":"right","format":"number","source_key":"shif"},{"id":"col_h","width":"1fr","align":"right","format":"number","source_key":"prmf"},{"id":"col_i","width":"1fr","align":"right","format":"number","source_key":"mortgage_interest_relief_base"},{"id":"col_j","width":"1fr","align":"right","format":"number"},{"id":"col_k","width":"1fr","align":"right","format":"number"},{"id":"col_l","width":"1fr","align":"right","format":"number"},{"id":"col_m","width":"1fr","align":"right","format":"number","source_key":"personal_relief"},{"id":"col_n","width":"1fr","align":"right","format":"number","source_key":"insurance_relief"},{"id":"col_o","width":"1fr","align":"right","format":"number","source_key":"paye"}],"rule_codes":["basic","housing_allowance","transport_allowance","non_cash_benefits","housing_benefit","nssf","housing_levy","shif","prmf","mortgage_interest_relief_base","paye","personal_relief","insurance_relief"],"derived_columns":[{"key":"col_d","expr":"sum","args":["col_a","housing_allowance","transport_allowance","col_b","col_c"]},{"key":"col_e1","expr":"pct","args":["col_a",0.3]},{"key":"col_e3","expr":"min","args":["col_e1","col_e2",30000]},{"key":"col_j","expr":"sum","args":["col_e3","col_f","col_g","col_h","col_i"]},{"key":"col_k","expr":"sub","args":["col_d","col_j"]},{"key":"col_l","expr":"sum","args":["col_o","col_m","col_n"]}],"amount_field":"employee_amount","header_rows":[[{"content":{"kind":"literal","value":"MONTH"},"row_span":4,"variant":"label","align":"center"},{"content":{"kind":"literal","value":"Basic Salary"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Benefits – Non-Cash"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Value of Quarters"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Total Gross Pay"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Defined Contribution Retirement Scheme"},"span":3,"variant":"label"},{"content":{"kind":"literal","value":"Affordable Housing Levy (AHL)"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Social Health Insurance Fund (SHIF)"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Post Retirement Medical Fund (PRMF)"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Owner-Occupied Interest"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Total Deductions (Lower of E+F+G+H+I)"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Chargeable Pay (D–J)"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Tax Charged"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Personal Relief"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"Insurance Relief"},"row_span":2,"variant":"label"},{"content":{"kind":"literal","value":"PAYE Tax (L-M-N)"},"row_span":2,"variant":"label"}],[{"content":{"kind":"literal","value":"Kshs."},"variant":"unit","align":"center"},{"content":{"kind":"literal","value":"Kshs."},"variant":"unit","align":"center"},{"content":{"kind":"literal","value":"Kshs."},"variant":"unit","align":"center"}],[{"content":{"kind":"literal","value":"A"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"B"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"C"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"D"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"E1"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"E2"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"E3"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"F"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"G"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"H"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"I"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"J"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"K"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"L"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"M"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"N"},"variant":"letter","align":"center"},{"content":{"kind":"literal","value":"O"},"variant":"letter","align":"center"}],[{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":"30% of A"},"variant":"note","align":"center"},{"content":{"kind":"literal","value":"Actual"},"variant":"note","align":"center"},{"content":{"kind":"literal","value":"Fixed 30,000 p.m"},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"},{"content":{"kind":"literal","value":""},"variant":"note","align":"center"}]],"data_rows":{"bind":"p9.months"},"footer_rows":[[{"content":{"kind":"literal","value":"TOTAL"},"align":"left","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_a","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_b","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_c","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_d","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_e1","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_e2","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_e3","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_f","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_g","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_h","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_i","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_j","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_k","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_l","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_m","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_n","format":"number"},"align":"right","variant":"total"},{"content":{"kind":"sum_of","column_id":"col_o","format":"number"},"align":"right","variant":"total"}]],"repeat_header":true,"border":"all","zebra":"none"},{"type":"spacer","size_mm":2},{"type":"rich_text","paragraphs":[[{"text":{"kind":"literal","value":"To be completed by Employer at end of year"},"emphasis":"italic"}]]},{"type":"field_row","gap_mm":8,"columns":["1fr","1fr"],"fields":[{"type":"label_fill","label":{"kind":"literal","value":"TOTAL CHARGEABLE PAY (COL. K)  Kshs."},"value":{"kind":"binding","path":"totals.chargeable_pay","format":"number","fallback":""},"rule":"dotted","label_bold":true,"emphasis":"primary"},{"type":"label_fill","label":{"kind":"literal","value":"TOTAL TAX (COL. O)  Kshs."},"value":{"kind":"binding","path":"totals.paye","format":"number","fallback":""},"rule":"dotted","label_bold":true,"emphasis":"primary"}]},{"type":"spacer","size_mm":3},{"type":"section","keep_together":true,"children":[{"type":"rich_text","paragraphs":[[{"text":{"kind":"literal","value":"IMPORTANT"},"emphasis":"bold"}]]},{"type":"columns","count":2,"gap_mm":8,"column_children":[[{"type":"list","marker":"decimal","compact":true,"items":[{"text":{"kind":"literal","value":"Use P9A"},"children":{"type":"list","marker":"lower-alpha-paren","compact":true,"items":[{"text":{"kind":"literal","value":"For all liable employees and where director/employee received Benefits in addition to cash emoluments"}},{"text":{"kind":"literal","value":"Where an employee is eligible to deduction on owner occupier interest."}},{"text":{"kind":"literal","value":"Where an employee contributes to a post retirement medical fund"}}]}},{"text":{"kind":"literal","value":""},"children":{"type":"list","marker":"lower-alpha-paren","compact":true,"items":[{"text":{"kind":"literal","value":"Deductible interest in respect of any month prior to December 2024 must not exceed Kshs. 25,000/= and commencing December 2024 must not exceed 30,000/="}},{"text":{"kind":"literal","value":"Deductible pension contribution in respect of any month prior to December 2024 must not exceed Kshs. 20,000/= and commencing December 2024 must not exceed 30,000/="}},{"text":{"kind":"literal","value":"Deductible contribution to a post retirement medical fund in respect of any month is effective from December 2024, must not exceed Kshs.15,000/="}},{"text":{"kind":"literal","value":"Deductible Contribution to the Social Health Insurance Fund (SHIF) and deductions made towards Affordable Housing Levy (AHL) are effective December 2024"}},{"text":{"kind":"literal","value":"Personal Relief is Kshs. 2,400 per Month or 28,800 per year"}},{"text":{"kind":"literal","value":"Insurance Relief is 15% of the Premium up to a Maximum of Kshs. 5,000 per month or Kshs. 60,000 per year"}}]}}]}],[{"type":"list","marker":"lower-alpha-paren","compact":true,"start":3,"items":[{"text":{"kind":"literal","value":"Attach"},"children":{"type":"list","marker":"lower-roman-paren","compact":true,"items":[{"text":{"kind":"literal","value":"Photostat copy of interest certificate and statement of account from the Financial Institution"}},{"text":{"kind":"literal","value":"The DECLARATION duly signed by the employee."}}]}}]}]]},{"type":"rich_text","paragraphs":[[{"text":{"kind":"literal","value":"P9A"},"emphasis":"bold"}]]}]}]}'::jsonb,
    display_name = 'Kenya — Tax Deduction Card (P9)',
    updated_at = now()
WHERE id = '8426e8da-f9c9-48cc-9d60-2dad85566e5c';

INSERT INTO public.pack_versions (pack_id, version, status, changelog, published_at)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  '10.1.5',
  'published',
  jsonb_build_object(
    'summary', 'P9A header + identity band now matches KRA Appendix 2A',
    'changes', jsonb_build_array(
      'Header: APPENDIX 2A left, centred KENYA REVENUE AUTHORITY DOMESTIC TAXES DEPARTMENT / TAX DEDUCTION CARD / YEAR 20 ..., ISO 9001:2015 CERTIFIED right',
      'Identity: inline dotted fill-in lines — Employer''s Name … Employer''s PIN, Employee''s Main Name … Employee''s PIN, Employee''s Other Names …',
      'Body republished from canonical keP9.ts v4 template',
      'Trigger enforce_certificate_template_structure updated to accept v4 primitives (field_row, grid) and make signature_strip optional for statutory forms without a signature band'
    ),
    'calculation_changes', false
  ),
  now()
);