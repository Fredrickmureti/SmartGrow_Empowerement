
-- Step 1 of the approved plan: migrate every non-v3 certificate template body
-- to the country-agnostic Certificate Engine v3 AST so they render via the
-- HTML + CSS Paged Media pipeline (paged.js) instead of the legacy pdf-lib
-- renderer. Country semantics live entirely in each pack row below; the
-- engine never learns what P9A / P9 / CERT_OF_SERVICE means.

-- ── P9A (Kenya, low-income employees) ────────────────────────────────
UPDATE public.localization_pack_certificate_templates
SET body = $json$
{
  "schema_version": 3,
  "code": "P9A",
  "display_name": "Kenya — Tax Deduction Card (P9A, Low-Income Employees)",
  "paper_format": {
    "size": "A4", "orientation": "landscape",
    "margin_top": 26, "margin_right": 10, "margin_bottom": 14, "margin_left": 10,
    "header_height": 22, "footer_height": 10
  },
  "page_master": {
    "code": "ke.p9a.page_master.v1",
    "header": [
      { "type": "rich_text", "align": "right",
        "paragraphs": [[{ "text": {"kind":"literal","value":"APPENDIX 2A"}, "emphasis": "muted" }]] },
      { "type": "heading", "level": 1, "align": "center",
        "text": {"kind":"literal","value":"KENYA REVENUE AUTHORITY — DOMESTIC TAXES DEPARTMENT"} },
      { "type": "heading", "level": 2, "align": "center",
        "text": {"kind":"literal","value":"TAX DEDUCTION CARD (P9A — Low-Income Employees)"} }
    ],
    "footer": [
      { "type": "rich_text", "align": "center",
        "paragraphs": [[
          { "text": {"kind":"literal","value":"Serial "}, "emphasis": "muted" },
          { "text": {"kind":"binding","path":"serial_number"} },
          { "text": {"kind":"literal","value":"  ·  Generated "}, "emphasis": "muted" },
          { "text": {"kind":"binding","path":"generated_at"} }
        ]] }
    ]
  },
  "document": [
    { "type": "heading", "level": 2, "align": "left",
      "text": {"kind":"binding","path":"fiscal_year","format":"text","fallback":"Year of Income"} },
    { "type": "identity_strip",
      "left_title":  {"kind":"literal","value":"Employer"},
      "right_title": {"kind":"literal","value":"Employee"},
      "left": [
        { "type":"key_value","label":{"kind":"literal","value":"Name"},       "value":{"kind":"binding","path":"employer.name"} },
        { "type":"key_value","label":{"kind":"literal","value":"PIN"},        "value":{"kind":"binding","path":"employer.tax_pin"}, "emphasis":"primary" },
        { "type":"key_value","label":{"kind":"literal","value":"Tax Office"}, "value":{"kind":"binding","path":"employer.tax_office"} },
        { "type":"key_value","label":{"kind":"literal","value":"Address"},    "value":{"kind":"binding","path":"employer.address"} }
      ],
      "right": [
        { "type":"key_value","label":{"kind":"literal","value":"Main Name"},    "value":{"kind":"binding","path":"employee.full_name"} },
        { "type":"key_value","label":{"kind":"literal","value":"Other Names"},  "value":{"kind":"binding","path":"employee.other_names"} },
        { "type":"key_value","label":{"kind":"literal","value":"PIN"},          "value":{"kind":"binding","path":"employee.tax_pin"}, "emphasis":"primary" },
        { "type":"key_value","label":{"kind":"literal","value":"Employee No."}, "value":{"kind":"binding","path":"employee.employee_number"} }
      ]
    },
    { "type":"spacer","size_mm":3 },
    { "type":"matrix",
      "title":{"kind":"literal","value":"Monthly Deductions"},
      "rows_binding":"p9.months",
      "repeat_header":true,
      "column_groups":[
        { "label":{"kind":"literal","value":""}, "span":1 },
        { "label":{"kind":"literal","value":"Earnings"}, "span":4 },
        { "label":{"kind":"literal","value":"Defined Contribution Retirement"}, "span":3 },
        { "label":{"kind":"literal","value":"Statutory Deductions"}, "span":4 },
        { "label":{"kind":"literal","value":"Totals"}, "span":2 },
        { "label":{"kind":"literal","value":"Tax"}, "span":4 }
      ],
      "columns":[
        { "key":"month",  "header":{"kind":"literal","value":"Month"},               "sub_header":{"kind":"literal","value":""},   "width":18, "align":"left",  "format":"month_short" },
        { "key":"col_a",  "header":{"kind":"literal","value":"Basic Salary"},        "sub_header":{"kind":"literal","value":"A"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_b",  "header":{"kind":"literal","value":"Benefits — Non-Cash"}, "sub_header":{"kind":"literal","value":"B"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_c",  "header":{"kind":"literal","value":"Value of Quarters"},   "sub_header":{"kind":"literal","value":"C"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_d",  "header":{"kind":"literal","value":"Total Gross Pay"},     "sub_header":{"kind":"literal","value":"D"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_e1", "header":{"kind":"literal","value":"30% of A"},            "sub_header":{"kind":"literal","value":"E1"}, "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_e2", "header":{"kind":"literal","value":"Actual"},              "sub_header":{"kind":"literal","value":"E2"}, "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_e3", "header":{"kind":"literal","value":"Fixed 30,000 p.m"},    "sub_header":{"kind":"literal","value":"E3"}, "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_f",  "header":{"kind":"literal","value":"AHL"},                 "sub_header":{"kind":"literal","value":"F"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_g",  "header":{"kind":"literal","value":"SHIF"},                "sub_header":{"kind":"literal","value":"G"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_h",  "header":{"kind":"literal","value":"PRMF"},                "sub_header":{"kind":"literal","value":"H"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_i",  "header":{"kind":"literal","value":"Owner-Occupied Interest"}, "sub_header":{"kind":"literal","value":"I"}, "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_j",  "header":{"kind":"literal","value":"Total Deductions"},    "sub_header":{"kind":"literal","value":"J"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_k",  "header":{"kind":"literal","value":"Chargeable Pay"},      "sub_header":{"kind":"literal","value":"K"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_l",  "header":{"kind":"literal","value":"Tax Charged"},         "sub_header":{"kind":"literal","value":"L"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_m",  "header":{"kind":"literal","value":"Personal Relief"},     "sub_header":{"kind":"literal","value":"M"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_n",  "header":{"kind":"literal","value":"Insurance Relief"},    "sub_header":{"kind":"literal","value":"N"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" },
        { "key":"col_o",  "header":{"kind":"literal","value":"PAYE Tax"},            "sub_header":{"kind":"literal","value":"O"},  "unit":{"kind":"literal","value":"Kshs."}, "align":"right", "format":"number" }
      ],
      "footer": {
        "label":{"kind":"literal","value":"TOTAL"},
        "sum_columns":["col_a","col_b","col_c","col_d","col_e1","col_e2","col_e3","col_f","col_g","col_h","col_i","col_j","col_k","col_l","col_m","col_n","col_o"]
      }
    },
    { "type":"spacer","size_mm":3 },
    { "type":"section",
      "title":{"kind":"literal","value":"End-of-Year Summary"},
      "keep_together":true,
      "children":[
        { "type":"key_value","label":{"kind":"literal","value":"Total Chargeable Pay (Col. K)"}, "value":{"kind":"binding","path":"totals.chargeable_pay","format":"currency"}, "emphasis":"primary" },
        { "type":"key_value","label":{"kind":"literal","value":"Total PAYE (Col. O)"},           "value":{"kind":"binding","path":"totals.paye","format":"currency"}, "emphasis":"primary" }
      ]
    },
    { "type":"legal_notice",
      "title":{"kind":"literal","value":"Important"},
      "border":true,
      "paragraphs":[
        {"kind":"literal","value":"Use P9A for all liable employees, including where an employee received benefits in addition to cash emoluments, is eligible for owner-occupier interest relief, or contributes to a Post-Retirement Medical Fund."},
        {"kind":"literal","value":"From December 2024: deductible interest ≤ 30,000/=; deductible pension contribution ≤ 30,000/=; deductible PRMF contribution ≤ 15,000/=; SHIF and AHL deductions apply."},
        {"kind":"literal","value":"Personal Relief: Kshs. 2,400 per month (28,800 per year). Insurance Relief: 15% of premium up to Kshs. 5,000 per month (60,000 per year)."}
      ]
    },
    { "type":"spacer","size_mm":4 },
    { "type":"signature_strip",
      "slots":[
        {"caption":{"kind":"literal","value":"Employer Signature"}, "sub_caption":{"kind":"literal","value":"Name, Designation, Date & Official Stamp"}},
        {"caption":{"kind":"literal","value":"Employee Declaration"},"sub_caption":{"kind":"literal","value":"Signed by employee — attach with return"}}
      ]
    }
  ]
}
$json$::jsonb
WHERE code = 'P9A';

-- ── GH_PAYE_EMPLOYEE_ANNUAL (Ghana Revenue Authority — Employer PAYE Certificate) ──
UPDATE public.localization_pack_certificate_templates
SET body = $json$
{
  "schema_version": 3,
  "code": "GH_PAYE_EMPLOYEE_ANNUAL",
  "display_name": "Ghana — Employee PAYE Income Tax Certificate (Annual)",
  "paper_format": {
    "size": "A4", "orientation": "portrait",
    "margin_top": 22, "margin_right": 12, "margin_bottom": 14, "margin_left": 12,
    "header_height": 20, "footer_height": 10
  },
  "page_master": {
    "code": "gh.paye.page_master.v1",
    "header": [
      { "type":"heading","level":1,"align":"center",
        "text":{"kind":"literal","value":"GHANA REVENUE AUTHORITY — DOMESTIC TAX REVENUE DIVISION"} },
      { "type":"heading","level":2,"align":"center",
        "text":{"kind":"literal","value":"EMPLOYEE PAYE INCOME TAX CERTIFICATE (ANNUAL)"} }
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
    { "type":"heading","level":2,"align":"left",
      "text":{"kind":"binding","path":"fiscal_year","format":"text","fallback":"Year of Assessment"} },
    { "type":"identity_strip",
      "left_title":{"kind":"literal","value":"Employer"},
      "right_title":{"kind":"literal","value":"Employee"},
      "left":[
        {"type":"key_value","label":{"kind":"literal","value":"Name"},"value":{"kind":"binding","path":"employer.name"}},
        {"type":"key_value","label":{"kind":"literal","value":"TIN"}, "value":{"kind":"binding","path":"employer.tax_pin"},"emphasis":"primary"},
        {"type":"key_value","label":{"kind":"literal","value":"Address"},"value":{"kind":"binding","path":"employer.address"}}
      ],
      "right":[
        {"type":"key_value","label":{"kind":"literal","value":"Name"},"value":{"kind":"binding","path":"employee.full_name"}},
        {"type":"key_value","label":{"kind":"literal","value":"TIN"}, "value":{"kind":"binding","path":"employee.tax_pin"},"emphasis":"primary"},
        {"type":"key_value","label":{"kind":"literal","value":"Employee No."},"value":{"kind":"binding","path":"employee.employee_number"}},
        {"type":"key_value","label":{"kind":"literal","value":"National ID"},"value":{"kind":"binding","path":"employee.national_id"}}
      ]
    },
    { "type":"spacer","size_mm":3 },
    { "type":"matrix",
      "title":{"kind":"literal","value":"Monthly Emoluments & Tax"},
      "rows_binding":"gh_paye.months",
      "repeat_header":true,
      "column_groups":[
        {"label":{"kind":"literal","value":""},"span":1},
        {"label":{"kind":"literal","value":"Cash Emoluments"},"span":3},
        {"label":{"kind":"literal","value":"Contributions & Reliefs"},"span":3},
        {"label":{"kind":"literal","value":"Tax"},"span":2}
      ],
      "columns":[
        {"key":"month","header":{"kind":"literal","value":"Month"},"width":22,"align":"left","format":"month_short"},
        {"key":"basic","header":{"kind":"literal","value":"Basic Salary"},"unit":{"kind":"literal","value":"GHS"},"align":"right","format":"number"},
        {"key":"allowances","header":{"kind":"literal","value":"Allowances / Benefits"},"unit":{"kind":"literal","value":"GHS"},"align":"right","format":"number"},
        {"key":"gross","header":{"kind":"literal","value":"Total Gross"},"unit":{"kind":"literal","value":"GHS"},"align":"right","format":"number"},
        {"key":"ssnit","header":{"kind":"literal","value":"SSNIT (Tier 1)"},"unit":{"kind":"literal","value":"GHS"},"align":"right","format":"number"},
        {"key":"tier2","header":{"kind":"literal","value":"Tier 2 / Provident"},"unit":{"kind":"literal","value":"GHS"},"align":"right","format":"number"},
        {"key":"reliefs","header":{"kind":"literal","value":"Reliefs Granted"},"unit":{"kind":"literal","value":"GHS"},"align":"right","format":"number"},
        {"key":"chargeable","header":{"kind":"literal","value":"Chargeable Income"},"unit":{"kind":"literal","value":"GHS"},"align":"right","format":"number"},
        {"key":"paye","header":{"kind":"literal","value":"PAYE Tax"},"unit":{"kind":"literal","value":"GHS"},"align":"right","format":"number"}
      ],
      "footer":{
        "label":{"kind":"literal","value":"TOTAL"},
        "sum_columns":["basic","allowances","gross","ssnit","tier2","reliefs","chargeable","paye"]
      }
    },
    { "type":"spacer","size_mm":3 },
    { "type":"section",
      "title":{"kind":"literal","value":"Annual Summary"},
      "keep_together":true,
      "children":[
        {"type":"key_value","label":{"kind":"literal","value":"Total Chargeable Income"},"value":{"kind":"binding","path":"totals.chargeable_pay","format":"currency"},"emphasis":"primary"},
        {"type":"key_value","label":{"kind":"literal","value":"Total PAYE Remitted"},"value":{"kind":"binding","path":"totals.paye","format":"currency"},"emphasis":"primary"}
      ]
    },
    { "type":"legal_notice",
      "title":{"kind":"literal","value":"Declaration"},
      "border":true,
      "paragraphs":[
        {"kind":"literal","value":"I certify that the above information is a true record of emoluments paid and tax deducted at source and remitted to the Ghana Revenue Authority for the year of assessment stated above, in accordance with the Income Tax Act 2015 (Act 896)."}
      ]
    },
    { "type":"spacer","size_mm":4 },
    { "type":"signature_strip",
      "slots":[
        {"caption":{"kind":"literal","value":"Authorised Signatory"},"sub_caption":{"kind":"literal","value":"Name, Designation, Date & Company Stamp"}},
        {"caption":{"kind":"literal","value":"Employee Acknowledgement"},"sub_caption":{"kind":"literal","value":"Signature & Date"}}
      ]
    }
  ]
}
$json$::jsonb
WHERE code = 'GH_PAYE_EMPLOYEE_ANNUAL';

-- ── ANNUAL_EARNINGS_STATEMENT (country-neutral generic annual statement) ──
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
      "columns":[
        {"key":"month","header":{"kind":"literal","value":"Month"},"width":22,"align":"left","format":"month_short"},
        {"key":"gross","header":{"kind":"literal","value":"Gross Pay"},"align":"right","format":"number"},
        {"key":"benefits","header":{"kind":"literal","value":"Benefits / Allowances"},"align":"right","format":"number"},
        {"key":"deductions","header":{"kind":"literal","value":"Statutory Deductions"},"align":"right","format":"number"},
        {"key":"tax","header":{"kind":"literal","value":"Income Tax"},"align":"right","format":"number"},
        {"key":"net","header":{"kind":"literal","value":"Net Pay"},"align":"right","format":"number"}
      ],
      "footer":{
        "label":{"kind":"literal","value":"TOTAL"},
        "sum_columns":["gross","benefits","deductions","tax","net"]
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
$json$::jsonb
WHERE code = 'ANNUAL_EARNINGS_STATEMENT';

-- ── CERT_OF_SERVICE (Kenya Employment Act, Section 51) ────────────────
-- Textual certificate. We satisfy the trigger's matrix requirement with a
-- compact employment record matrix (position history rows).
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
    "code": "generic.cos.page_master.v1",
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
        {"type":"key_value","label":{"kind":"literal","value":"Date of Exit"},"value":{"kind":"binding","path":"employee.exit_date","format":"date"}},
        {"type":"key_value","label":{"kind":"literal","value":"Last Position Held"},"value":{"kind":"binding","path":"employee.position"}},
        {"type":"key_value","label":{"kind":"literal","value":"Department"},"value":{"kind":"binding","path":"employee.department"}}
      ]
    },
    { "type":"spacer","size_mm":3 },
    { "type":"matrix",
      "title":{"kind":"literal","value":"Positions Held"},
      "rows_binding":"service.positions",
      "repeat_header":true,
      "columns":[
        {"key":"from","header":{"kind":"literal","value":"From"},"align":"left","format":"date","width":32},
        {"key":"to","header":{"kind":"literal","value":"To"},"align":"left","format":"date","width":32},
        {"key":"position","header":{"kind":"literal","value":"Position"},"align":"left","format":"text"},
        {"key":"department","header":{"kind":"literal","value":"Department"},"align":"left","format":"text"}
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
$json$::jsonb
WHERE code = 'CERT_OF_SERVICE';

-- Success gate: every certificate template must be on schema_version 3.
DO $$
DECLARE
  _laggards INT;
BEGIN
  SELECT COUNT(*) INTO _laggards
  FROM public.localization_pack_certificate_templates
  WHERE COALESCE((body->>'schema_version')::INT, 1) < 3;
  IF _laggards > 0 THEN
    RAISE EXCEPTION 'Migration failed: % certificate template(s) are still on schema_version < 3.', _laggards;
  END IF;
END $$;
