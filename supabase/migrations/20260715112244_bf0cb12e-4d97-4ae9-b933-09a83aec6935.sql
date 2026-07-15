-- Republish ANNUAL_EARNINGS_STATEMENT with country-neutral canonical bindings.
-- Root cause of the 422 (TEMPLATE_STRUCTURAL_INVALID / MATRIX_NO_RULE_CODES)
-- is that the body shipped by migration 20260713001927 declared data
-- columns but no source_key / rule_codes / derived_columns. ADR-0061
-- explicitly flagged this template as latent. Fixed by binding every
-- data column via `derived_columns` referencing `cat:*` category
-- aggregates (country-neutral) with an empty `rule_codes: []` sentinel.
UPDATE public.localization_pack_certificate_templates
SET body = $json$
{
  "schema_version": 3,
  "code": "ANNUAL_EARNINGS_STATEMENT",
  "display_name": "Annual Earnings Statement",
  "paper_format": {
    "size": "A4", "orientation": "portrait",
    "margin_top": 20, "margin_right": 14, "margin_bottom": 14, "margin_left": 14,
    "header_height": 18, "footer_height": 10
  },
  "page_master": {
    "code": "generic.earnings.page_master.v1",
    "header": [
      { "type":"heading","level":1,"align":"center",
        "text":{"kind":"binding","path":"employer.name","fallback":"EMPLOYER"} },
      { "type":"heading","level":2,"align":"center",
        "text":{"kind":"literal","value":"Annual Earnings Statement"} }
    ],
    "footer": [
      { "type":"rich_text","align":"center",
        "paragraphs":[[
          {"text":{"kind":"literal","value":"Serial "},"emphasis":"muted"},
          {"text":{"kind":"binding","path":"serial_number"}},
          {"text":{"kind":"literal","value":"  ·  Generated "},"emphasis":"muted"},
          {"text":{"kind":"binding","path":"generated_at"}}
        ]] }
    ]
  },
  "document": [
    { "type":"heading","level":3,"align":"left",
      "text":{"kind":"binding","path":"period_label","format":"text","fallback":"Period"} },
    { "type":"identity_strip",
      "left_title":{"kind":"literal","value":"Employer"},
      "right_title":{"kind":"literal","value":"Employee"},
      "left":[
        {"type":"key_value","label":{"kind":"literal","value":"Name"},"value":{"kind":"binding","path":"employer.name"}},
        {"type":"key_value","label":{"kind":"literal","value":"Address"},"value":{"kind":"binding","path":"employer.address"}}
      ],
      "right":[
        {"type":"key_value","label":{"kind":"literal","value":"Name"},"value":{"kind":"binding","path":"employee.full_name"}},
        {"type":"key_value","label":{"kind":"literal","value":"Employee No."},"value":{"kind":"binding","path":"employee.employee_number"}},
        {"type":"key_value","label":{"kind":"literal","value":"Department"},"value":{"kind":"binding","path":"employee.department"}}
      ]
    },
    { "type":"spacer","size_mm":3 },
    { "type":"matrix",
      "title":{"kind":"literal","value":"Monthly Earnings & Deductions"},
      "rows_binding":"earnings.months",
      "repeat_header":true,
      "rule_codes":[],
      "amount_field":"employee_amount",
      "derived_columns":[
        { "key":"gross",      "expr":"sum", "args":["cat:earning"] },
        { "key":"benefits",   "expr":"sum", "args":["cat:benefit"] },
        { "key":"deductions", "expr":"sum", "args":["cat:statutory_employee","cat:deduction"] },
        { "key":"net",        "expr":"sub", "args":["gross","deductions"] }
      ],
      "columns":[
        {"key":"month","header":{"kind":"literal","value":"Month"},"width":22,"align":"left","format":"month_short"},
        {"key":"gross","header":{"kind":"literal","value":"Gross Pay"},"align":"right","format":"number"},
        {"key":"benefits","header":{"kind":"literal","value":"Benefits / Allowances"},"align":"right","format":"number"},
        {"key":"deductions","header":{"kind":"literal","value":"Statutory Deductions"},"align":"right","format":"number"},
        {"key":"net","header":{"kind":"literal","value":"Net Pay"},"align":"right","format":"number"}
      ],
      "footer":{
        "label":{"kind":"literal","value":"TOTAL"},
        "sum_columns":["gross","benefits","deductions","net"]
      }
    },
    { "type":"spacer","size_mm":3 },
    { "type":"section",
      "title":{"kind":"literal","value":"Year-to-Date Summary"},
      "keep_together":true,
      "children":[
        {"type":"key_value","label":{"kind":"literal","value":"Total Gross Pay"},"value":{"kind":"binding","path":"totals.gross_pay","format":"currency"},"emphasis":"primary"},
        {"type":"key_value","label":{"kind":"literal","value":"Total Deductions"},"value":{"kind":"binding","path":"totals.deductions","format":"currency"},"emphasis":"primary"},
        {"type":"key_value","label":{"kind":"literal","value":"Total Net Pay"},"value":{"kind":"binding","path":"totals.net_pay","format":"currency"},"emphasis":"primary"}
      ]
    },
    { "type":"spacer","size_mm":4 },
    { "type":"signature_strip",
      "slots":[
        {"caption":{"kind":"literal","value":"Authorised Signatory"},"sub_caption":{"kind":"literal","value":"Payroll Office"}}
      ]
    }
  ]
}
$json$::jsonb,
    updated_at = now()
WHERE code = 'ANNUAL_EARNINGS_STATEMENT' AND pack_id IS NULL;
