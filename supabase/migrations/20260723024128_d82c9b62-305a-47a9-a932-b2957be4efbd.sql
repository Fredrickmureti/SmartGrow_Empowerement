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
      "rule_codes": [],
      "amount_field": "employee_amount",
      "derived_columns": [
        { "key": "gross", "expr": "sum", "args": ["cat:earning"] },
        { "key": "benefits", "expr": "sum", "args": ["cat:benefit"] },
        { "key": "taxable", "expr": "sum", "args": ["cat:taxable"] },
        { "key": "statutory_employee", "expr": "sum", "args": ["cat:statutory_employee"] },
        { "key": "statutory_employer", "expr": "sum", "args": ["cat:statutory_employer"] },
        { "key": "other_deductions", "expr": "sum", "args": ["cat:deduction"] },
        { "key": "reliefs", "expr": "sum", "args": ["cat:relief"] },
        { "key": "net", "expr": "sub", "args": ["gross", "statutory_employee", "other_deductions"] }
      ],
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