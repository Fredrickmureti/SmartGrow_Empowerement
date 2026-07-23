CREATE OR REPLACE FUNCTION public.assert_certificate_template_body_valid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  _schema jsonb;
  _errs text[];
  _v int;
  _binding_errs text[] := ARRAY[]::text[];
BEGIN
  IF NEW.body IS NULL THEN
    RAISE EXCEPTION 'Certificate template % has NULL body', NEW.code;
  END IF;

  _v := COALESCE((NEW.body->>'schema_version')::int, 1);
  IF _v < 3 THEN
    RAISE EXCEPTION
      'Certificate template % rejected: schema_version=% is below the minimum (3). The pdf-lib v1/v2 renderers have been retired; author the body as a v3 engine AST.',
      NEW.code, _v;
  END IF;

  -- Column-binding contract: statutory templates must bind every non-month
  -- data column to source_key or derived_columns. The country-neutral Annual
  -- Earnings Statement is exempt because it is not a statutory matrix: its
  -- matrix rows bind directly to AnnualEarningsStatementDTO.months, whose
  -- values are produced by resolveAnnualEarnings() before compilation.
  WITH RECURSIVE nodes(node) AS (
    SELECT n
    FROM jsonb_array_elements(COALESCE(NEW.body->'document','[]'::jsonb)) AS n
    UNION ALL
    SELECT child
    FROM nodes,
    LATERAL (
      SELECT jsonb_array_elements(node->'children') AS child
      WHERE jsonb_typeof(node->'children') = 'array'
      UNION ALL
      SELECT jsonb_array_elements(sub) AS child
      FROM jsonb_array_elements(COALESCE(node->'column_children','[]'::jsonb)) AS sub
      WHERE jsonb_typeof(node->'column_children') = 'array'
        AND jsonb_typeof(sub) = 'array'
    ) AS unpacked(child)
  ),
  data_nodes AS (
    SELECT node
    FROM nodes
    WHERE node->>'type' IN ('grid','matrix','table')
  ),
  offences AS (
    SELECT
      dn.node->>'type' AS node_type,
      col->>'id'   AS col_id,
      col->>'key'  AS col_key
    FROM data_nodes dn,
         LATERAL jsonb_array_elements(COALESCE(dn.node->'columns','[]'::jsonb)) AS col
    WHERE
      NOT (
        NEW.code = 'ANNUAL_EARNINGS_STATEMENT'
        AND COALESCE(NEW.body->>'dto_version','') = 'annual-earnings.v1'
      )
      AND COALESCE(col->>'id','')   NOT IN ('month','month_index')
      AND COALESCE(col->>'key','')  NOT IN ('month','month_index')
      AND COALESCE(lower(col->>'format'),'') <> 'month_short'
      AND COALESCE(col->>'key', col->>'bind_key', col->>'id','') <> ''
      AND COALESCE(col->>'source_key','') = ''
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(dn.node->'derived_columns','[]'::jsonb)) AS d
        WHERE d->>'key' = COALESCE(col->>'key', col->>'bind_key', col->>'id')
      )
  )
  SELECT array_agg(
    format('%s column %s',
           node_type,
           COALESCE(col_key, col_id, '?'))
  )
  INTO _binding_errs
  FROM offences;

  IF _binding_errs IS NOT NULL AND array_length(_binding_errs, 1) > 0 THEN
    RAISE EXCEPTION
      'Certificate template % rejected: unbound data column(s): %. Every non-month column must set `source_key` (canonical rule code) or appear as a key in the node''s `derived_columns`. Statutory templates must never render unbound zeros.',
      NEW.code,
      array_to_string(_binding_errs, ', ');
  END IF;

  SELECT json_schema INTO _schema
  FROM public.pack_rule_type_schemas
  WHERE rule_type='certificate_template' AND computation_kind='v2'
  ORDER BY schema_version DESC LIMIT 1;

  IF _schema IS NULL THEN
    NEW.legacy_unvalidated := true;
    RETURN NEW;
  END IF;

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
$function$;

UPDATE public.localization_pack_certificate_templates
SET body = $json$
{
  "schema_version": 3,
  "code": "ANNUAL_EARNINGS_STATEMENT",
  "display_name": "Annual Earnings Statement",
  "dto_version": "annual-earnings.v1",
  "extension_regions": ["after_ytd", "after_signature", "appendix"],
  "paper_format": {
    "size": "A4",
    "orientation": "portrait",
    "margin_top": 18,
    "margin_right": 14,
    "margin_bottom": 14,
    "margin_left": 14,
    "header_height": 20,
    "footer_height": 12
  },
  "page_master": {
    "code": "generic.earnings.page_master.v2",
    "header": [
      { "type": "heading", "level": 1, "align": "center", "text": { "kind": "binding", "path": "employer.name", "fallback": "EMPLOYER" } },
      { "type": "heading", "level": 2, "align": "center", "text": { "kind": "literal", "value": "Annual Earnings Statement" } }
    ],
    "footer": [
      {
        "type": "rich_text",
        "align": "center",
        "paragraphs": [[
          { "text": { "kind": "literal", "value": "Serial " }, "emphasis": "muted" },
          { "text": { "kind": "binding", "path": "serial_number" } },
          { "text": { "kind": "literal", "value": "  ·  Generated " }, "emphasis": "muted" },
          { "text": { "kind": "binding", "path": "generated_at" } },
          { "text": { "kind": "literal", "value": "  ·  Content " }, "emphasis": "muted" },
          { "text": { "kind": "binding", "path": "provenance.content_hash_short" } }
        ]]
      }
    ]
  },
  "document": [
    { "type": "heading", "level": 3, "align": "left", "text": { "kind": "binding", "path": "period.label", "format": "text", "fallback": "Period" } },
    {
      "type": "identity_strip",
      "left_title": { "kind": "literal", "value": "Employer" },
      "right_title": { "kind": "literal", "value": "Employee" },
      "left": [
        { "type": "key_value", "label": { "kind": "literal", "value": "Name" }, "value": { "kind": "binding", "path": "employer.name" } },
        { "type": "key_value", "label": { "kind": "literal", "value": "Legal name" }, "value": { "kind": "binding", "path": "employer.legal_name" }, "optional": true },
        { "type": "key_value", "label": { "kind": "literal", "value": "Address" }, "value": { "kind": "binding", "path": "employer.registered_address" }, "optional": true },
        { "type": "key_value", "label": { "kind": "literal", "value": "Contact" }, "value": { "kind": "binding", "path": "employer.contact" }, "optional": true }
      ],
      "right": [
        { "type": "key_value", "label": { "kind": "literal", "value": "Name" }, "value": { "kind": "binding", "path": "employee.full_name" } },
        { "type": "key_value", "label": { "kind": "literal", "value": "Employee No." }, "value": { "kind": "binding", "path": "employee.employee_number" }, "optional": true },
        { "type": "key_value", "label": { "kind": "literal", "value": "Department" }, "value": { "kind": "binding", "path": "employee.department" }, "optional": true },
        { "type": "key_value", "label": { "kind": "literal", "value": "Position" }, "value": { "kind": "binding", "path": "employee.position" }, "optional": true },
        { "type": "key_value", "label": { "kind": "literal", "value": "Employment period" }, "value": { "kind": "binding", "path": "employee.employment_period.label" } }
      ]
    },
    { "type": "spacer", "size_mm": 3 },
    {
      "type": "matrix",
      "title": { "kind": "literal", "value": "Monthly Earnings & Deductions" },
      "rows_binding": "months",
      "repeat_header": true,
      "columns": [
        { "key": "month", "header": { "kind": "literal", "value": "Month" }, "width": 18, "align": "left", "format": "month_short" },
        { "key": "gross", "header": { "kind": "literal", "value": "Gross" }, "align": "right", "format": "number" },
        { "key": "benefits", "header": { "kind": "literal", "value": "Benefits" }, "align": "right", "format": "number" },
        { "key": "taxable", "header": { "kind": "literal", "value": "Taxable" }, "align": "right", "format": "number" },
        { "key": "statutory_employee", "header": { "kind": "literal", "value": "Statutory (EE)" }, "align": "right", "format": "number" },
        { "key": "statutory_employer", "header": { "kind": "literal", "value": "Statutory (ER)" }, "align": "right", "format": "number" },
        { "key": "other_deductions", "header": { "kind": "literal", "value": "Other Deductions" }, "align": "right", "format": "number" },
        { "key": "reliefs", "header": { "kind": "literal", "value": "Reliefs" }, "align": "right", "format": "number" },
        { "key": "net", "header": { "kind": "literal", "value": "Net Pay" }, "align": "right", "format": "number" }
      ],
      "footer": { "label": { "kind": "literal", "value": "TOTAL" }, "sum_columns": ["gross", "benefits", "taxable", "statutory_employee", "statutory_employer", "other_deductions", "reliefs", "net"] }
    },
    { "type": "spacer", "size_mm": 3 },
    {
      "type": "section",
      "title": { "kind": "literal", "value": "Year-to-Date Summary" },
      "keep_together": true,
      "children": [
        { "type": "key_value", "label": { "kind": "literal", "value": "Total Gross Pay" }, "value": { "kind": "binding", "path": "ytd.gross", "format": "currency" }, "emphasis": "primary" },
        { "type": "key_value", "label": { "kind": "literal", "value": "Total Benefits" }, "value": { "kind": "binding", "path": "ytd.benefits", "format": "currency" } },
        { "type": "key_value", "label": { "kind": "literal", "value": "Total Taxable" }, "value": { "kind": "binding", "path": "ytd.taxable", "format": "currency" } },
        { "type": "key_value", "label": { "kind": "literal", "value": "Total Statutory Deductions (Employee)" }, "value": { "kind": "binding", "path": "ytd.statutory_employee", "format": "currency" } },
        { "type": "key_value", "label": { "kind": "literal", "value": "Total Employer Contributions" }, "value": { "kind": "binding", "path": "ytd.employer_contributions_total", "format": "currency" } },
        { "type": "key_value", "label": { "kind": "literal", "value": "Total Other Deductions" }, "value": { "kind": "binding", "path": "ytd.other_deductions", "format": "currency" } },
        { "type": "key_value", "label": { "kind": "literal", "value": "Total Reliefs" }, "value": { "kind": "binding", "path": "ytd.reliefs", "format": "currency" } },
        { "type": "key_value", "label": { "kind": "literal", "value": "Total Net Pay" }, "value": { "kind": "binding", "path": "ytd.net", "format": "currency" }, "emphasis": "primary" }
      ]
    },
    { "type": "extension_region", "region": "after_ytd" },
    { "type": "spacer", "size_mm": 4 },
    { "type": "signature_strip", "slots": [{ "caption": { "kind": "binding", "path": "issuer.name", "fallback": "Authorised Signatory" }, "sub_caption": { "kind": "binding", "path": "issuer.title", "fallback": "Payroll Office" } }] },
    { "type": "extension_region", "region": "after_signature" },
    { "type": "extension_region", "region": "appendix" }
  ]
}
$json$::jsonb,
updated_at = now()
WHERE code = 'ANNUAL_EARNINGS_STATEMENT'
  AND pack_id IS NULL;