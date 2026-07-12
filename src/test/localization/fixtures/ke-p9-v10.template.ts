/**
 * Kenya P9 v10 template — v3 AST fixture.
 *
 * This is the reference expression of the KRA P9 statutory certificate
 * in the country-agnostic v3 document AST. It lives in the test tree
 * (not the pack DB) until the v3 PdfProducer is chosen; when the pack
 * ships, the same JSON is inserted into
 * `localization_pack_certificate_templates.body` for KE pack v10.
 *
 * Blueprint fields (KRA appendix 2A, 2025 revision):
 *   A  Basic Salary
 *   B  Benefits — Non-Cash
 *   C  Value of Quarters
 *   D  Total Gross Pay
 *   E1 30% of A   | E2 Actual | E3 Fixed 30,000 p.m       (retirement)
 *   F  Affordable Housing Levy (AHL)
 *   G  Social Health Insurance Fund (SHIF)
 *   H  Post Retirement Medical Fund (PRMF)
 *   I  Owner-Occupied Interest
 *   J  Total Deductions (E + F + G + H + I)
 *   K  Chargeable Pay (D − J)
 *   L  Tax Charged
 *   M  Personal Relief
 *   N  Insurance Relief
 *   O  PAYE Tax (L − M − N)
 *
 * Every user-visible string is a literal on the node — pack-authored,
 * not renderer-hardcoded. Every numeric value is a `binding` into the
 * payload assembled by `generate-tax-certificate`.
 */
import type { CertificateTemplateV3, Node } from "../../../supabase/functions/_shared/certificate-engine/types";

const lit = (v: string | number) => ({ kind: "literal" as const, value: v });
const bind = (path: string, fallback = "") =>
  ({ kind: "binding" as const, path, fallback });
const bindFmt = (path: string, format: any, fallback = "") =>
  ({ kind: "binding" as const, path, format, fallback });

const identity: Node = {
  type: "identity_strip",
  left_title: lit("Employer"),
  right_title: lit("Employee"),
  left: [
    { type: "key_value", label: lit("Name"),         value: bind("employer.name") },
    { type: "key_value", label: lit("PIN"),          value: bind("employer.tax_pin"), emphasis: "primary" },
    { type: "key_value", label: lit("Tax Office"),   value: bind("employer.tax_office") },
    { type: "key_value", label: lit("Address"),      value: bind("employer.address") },
  ],
  right: [
    { type: "key_value", label: lit("Main Name"),    value: bind("employee.full_name") },
    { type: "key_value", label: lit("Other Names"),  value: bind("employee.other_names") },
    { type: "key_value", label: lit("PIN"),          value: bind("employee.tax_pin"), emphasis: "primary" },
    { type: "key_value", label: lit("Employee No."), value: bind("employee.employee_number") },
  ],
};

const matrixColumns = [
  { key: "month",  header: lit("Month"),          width: 22,      align: "left"  as const, format: "month_short" as const },
  { key: "col_a",  header: lit("A"),              align: "right" as const, format: "number" as const, group: "identity" },
  { key: "col_b",  header: lit("B"),              align: "right" as const, format: "number" as const },
  { key: "col_c",  header: lit("C"),              align: "right" as const, format: "number" as const },
  { key: "col_d",  header: lit("D"),              align: "right" as const, format: "number" as const },
  { key: "col_e1", header: lit("E1"),             align: "right" as const, format: "number" as const, group: "retirement" },
  { key: "col_e2", header: lit("E2"),             align: "right" as const, format: "number" as const, group: "retirement" },
  { key: "col_e3", header: lit("E3"),             align: "right" as const, format: "number" as const, group: "retirement" },
  { key: "col_f",  header: lit("F"),              align: "right" as const, format: "number" as const },
  { key: "col_g",  header: lit("G"),              align: "right" as const, format: "number" as const },
  { key: "col_h",  header: lit("H"),              align: "right" as const, format: "number" as const },
  { key: "col_i",  header: lit("I"),              align: "right" as const, format: "number" as const },
  { key: "col_j",  header: lit("J"),              align: "right" as const, format: "number" as const },
  { key: "col_k",  header: lit("K"),              align: "right" as const, format: "number" as const },
  { key: "col_l",  header: lit("L"),              align: "right" as const, format: "number" as const },
  { key: "col_m",  header: lit("M"),              align: "right" as const, format: "number" as const },
  { key: "col_n",  header: lit("N"),              align: "right" as const, format: "number" as const },
  { key: "col_o",  header: lit("O"),              align: "right" as const, format: "number" as const },
];

const matrix: Node = {
  type: "matrix",
  title: lit("Monthly Deductions"),
  rows_binding: "p9.months",
  repeat_header: true,
  columns: matrixColumns,
  column_groups: [
    { label: lit(""),                                     span: 1  }, // Month
    { label: lit("Earnings"),                             span: 4  }, // A..D
    { label: lit("Defined Contribution Retirement"),      span: 3  }, // E1..E3
    { label: lit("Statutory Deductions"),                 span: 4  }, // F..I
    { label: lit("Totals"),                               span: 2  }, // J..K
    { label: lit("Tax"),                                  span: 4  }, // L..O
  ],
  footer: {
    label: lit("TOTAL"),
    sum_columns: [
      "col_a","col_b","col_c","col_d",
      "col_e1","col_e2","col_e3",
      "col_f","col_g","col_h","col_i",
      "col_j","col_k","col_l","col_m","col_n","col_o",
    ],
  },
};

export const KE_P9_V10_TEMPLATE: CertificateTemplateV3 = {
  schema_version: 3,
  code: "KE_P9_2025",
  display_name: "Kenya — Tax Deduction Card (P9)",
  paper_format: {
    size: "A4",
    orientation: "landscape",
    margin_top: 12, margin_right: 10, margin_bottom: 12, margin_left: 10,
    header_height: 14, footer_height: 10,
  },
  page_master: {
    code: "ke.p9.page_master.v10",
    header: [
      {
        type: "rich_text",
        align: "right",
        paragraphs: [[{ text: lit("APPENDIX 2A"), emphasis: "muted" }]],
      },
      {
        type: "heading", level: 1, align: "center",
        text: lit("KENYA REVENUE AUTHORITY — DOMESTIC TAXES DEPARTMENT"),
      },
      {
        type: "heading", level: 2, align: "center",
        text: lit("TAX DEDUCTION CARD"),
      },
    ],
    footer: [
      {
        type: "rich_text",
        align: "center",
        paragraphs: [[
          { text: lit("Serial "), emphasis: "muted" },
          { text: bind("serial_number") },
          { text: lit("  ·  Generated "), emphasis: "muted" },
          { text: bind("generated_at") },
        ]],
      },
    ],
  },
  document: [
    { type: "heading", level: 2, align: "left",
      text: bindFmt("fiscal_year", "text", "Year of Income") as any },
    identity,
    { type: "spacer", size_mm: 3 },
    matrix,
    { type: "spacer", size_mm: 3 },
    {
      type: "section",
      title: lit("End-of-Year Summary"),
      keep_together: true,
      children: [
        { type: "key_value",
          label: lit("Total Chargeable Pay (Col. K)"),
          value: bindFmt("totals.chargeable_pay", "currency"),
          emphasis: "primary" },
        { type: "key_value",
          label: lit("Total PAYE (Col. O)"),
          value: bindFmt("totals.paye", "currency"),
          emphasis: "primary" },
      ],
    },
    {
      type: "legal_notice",
      title: lit("Important"),
      border: true,
      paragraphs: [
        lit("Use P9A for all liable employees, including where an employee received benefits in addition to cash emoluments, is eligible for owner-occupier interest relief, or contributes to a Post-Retirement Medical Fund."),
        lit("From December 2024: deductible interest ≤ 30,000/=; deductible pension contribution ≤ 30,000/=; deductible PRMF contribution ≤ 15,000/=; SHIF and AHL deductions apply."),
        lit("Personal Relief: Kshs. 2,400 per month (28,800 per year). Insurance Relief: 15% of premium up to Kshs. 5,000 per month (60,000 per year)."),
      ],
    },
    { type: "spacer", size_mm: 4 },
    {
      type: "signature_strip",
      slots: [
        { caption: lit("Employer Signature"),
          sub_caption: lit("Name, Designation, Date & Official Stamp") },
        { caption: lit("Employee Declaration"),
          sub_caption: lit("Signed by employee — attach with return") },
      ],
    },
  ],
};
