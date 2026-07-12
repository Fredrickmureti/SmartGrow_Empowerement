/**
 * Canonical Kenya P9 (Tax Deduction Card) — Certificate Engine v3 body.
 *
 * Single source of truth for the KRA P9A layout. Referenced by:
 *   • the publisher editor "Seed from Kenya P9" action,
 *   • the live-preview fixture,
 *   • the DB migration that ships the KE pack template (mirrored as JSON).
 *
 * Country knowledge lives ENTIRELY in this pack-authored data — the engine
 * (compile.ts) never mentions P9, KRA, or Kenya. Any country can author an
 * equivalent body with the same generic node/column primitives.
 */
import type { CertificateTemplateV3, MatrixColumn, Node } from "../types";

const lit = (v: string | number) => ({ kind: "literal" as const, value: v });
const bind = (path: string, fallback = "") => ({ kind: "binding" as const, path, fallback });
const bindFmt = (path: string, format: any, fallback = "") =>
  ({ kind: "binding" as const, path, format, fallback });

const kshs = lit("Kshs.");

const matrixColumns: MatrixColumn[] = [
  { key: "month",  header: lit("Month"),               sub_header: lit(""),   width: 18, align: "left",  format: "month_short" },
  { key: "col_a",  header: lit("Basic Salary"),        sub_header: lit("A"),  unit: kshs, align: "right", format: "number" },
  { key: "col_b",  header: lit("Benefits — Non-Cash"), sub_header: lit("B"),  unit: kshs, align: "right", format: "number" },
  { key: "col_c",  header: lit("Value of Quarters"),   sub_header: lit("C"),  unit: kshs, align: "right", format: "number" },
  { key: "col_d",  header: lit("Total Gross Pay"),     sub_header: lit("D"),  unit: kshs, align: "right", format: "number" },
  { key: "col_e1", header: lit("30% of A"),            sub_header: lit("E1"), unit: kshs, align: "right", format: "number" },
  { key: "col_e2", header: lit("Actual"),              sub_header: lit("E2"), unit: kshs, align: "right", format: "number" },
  { key: "col_e3", header: lit("Fixed 30,000 p.m"),    sub_header: lit("E3"), unit: kshs, align: "right", format: "number" },
  { key: "col_f",  header: lit("AHL"),                 sub_header: lit("F"),  unit: kshs, align: "right", format: "number" },
  { key: "col_g",  header: lit("SHIF"),                sub_header: lit("G"),  unit: kshs, align: "right", format: "number" },
  { key: "col_h",  header: lit("PRMF"),                sub_header: lit("H"),  unit: kshs, align: "right", format: "number" },
  { key: "col_i",  header: lit("Owner-Occupied Interest"), sub_header: lit("I"), unit: kshs, align: "right", format: "number" },
  { key: "col_j",  header: lit("Total Deductions"),    sub_header: lit("J"),  unit: kshs, align: "right", format: "number" },
  { key: "col_k",  header: lit("Chargeable Pay"),      sub_header: lit("K"),  unit: kshs, align: "right", format: "number" },
  { key: "col_l",  header: lit("Tax Charged"),         sub_header: lit("L"),  unit: kshs, align: "right", format: "number" },
  { key: "col_m",  header: lit("Personal Relief"),     sub_header: lit("M"),  unit: kshs, align: "right", format: "number" },
  { key: "col_n",  header: lit("Insurance Relief"),    sub_header: lit("N"),  unit: kshs, align: "right", format: "number" },
  { key: "col_o",  header: lit("PAYE Tax"),            sub_header: lit("O"),  unit: kshs, align: "right", format: "number" },
];

const matrix: Node = {
  type: "matrix",
  title: lit("Monthly Deductions"),
  rows_binding: "p9.months",
  repeat_header: true,
  columns: matrixColumns,
  column_groups: [
    { label: lit(""),                                span: 1 }, // Month
    { label: lit("Earnings"),                        span: 4 }, // A..D
    { label: lit("Defined Contribution Retirement"), span: 3 }, // E1..E3
    { label: lit("Statutory Deductions"),            span: 4 }, // F..I
    { label: lit("Totals"),                          span: 2 }, // J..K
    { label: lit("Tax"),                             span: 4 }, // L..O
  ],
  footer: {
    label: lit("TOTAL"),
    sum_columns: [
      "col_a", "col_b", "col_c", "col_d",
      "col_e1", "col_e2", "col_e3",
      "col_f", "col_g", "col_h", "col_i",
      "col_j", "col_k", "col_l", "col_m", "col_n", "col_o",
    ],
  },
};

export const KE_P9_V3_TEMPLATE: CertificateTemplateV3 = {
  schema_version: 3,
  code: "P9",
  display_name: "Kenya — Tax Deduction Card (P9)",
  paper_format: {
    size: "A4",
    orientation: "landscape",
    margin_top: 26, margin_right: 10, margin_bottom: 14, margin_left: 10,
    header_height: 22, footer_height: 10,
  },
  page_master: {
    code: "ke.p9.page_master.v10",
    header: [
      { type: "rich_text", align: "right",
        paragraphs: [[{ text: lit("APPENDIX 2A"), emphasis: "muted" }]] },
      { type: "heading", level: 1, align: "center",
        text: lit("KENYA REVENUE AUTHORITY — DOMESTIC TAXES DEPARTMENT") },
      { type: "heading", level: 2, align: "center",
        text: lit("TAX DEDUCTION CARD") },
    ],
    footer: [
      { type: "rich_text", align: "center",
        paragraphs: [[
          { text: lit("Serial "), emphasis: "muted" },
          { text: bind("serial_number") },
          { text: lit("  ·  Generated "), emphasis: "muted" },
          { text: bind("generated_at") },
        ]] },
    ],
  },
  document: [
    { type: "heading", level: 2, align: "left",
      text: bindFmt("fiscal_year", "text", "Year of Income") as any },
    {
      type: "identity_strip",
      left_title: lit("Employer"),
      right_title: lit("Employee"),
      left: [
        { type: "key_value", label: lit("Name"),       value: bind("employer.name") },
        { type: "key_value", label: lit("PIN"),        value: bind("employer.tax_pin"), emphasis: "primary" },
        { type: "key_value", label: lit("Tax Office"), value: bind("employer.tax_office") },
        { type: "key_value", label: lit("Address"),    value: bind("employer.address") },
      ],
      right: [
        { type: "key_value", label: lit("Main Name"),    value: bind("employee.full_name") },
        { type: "key_value", label: lit("Other Names"),  value: bind("employee.other_names") },
        { type: "key_value", label: lit("PIN"),          value: bind("employee.tax_pin"), emphasis: "primary" },
        { type: "key_value", label: lit("Employee No."), value: bind("employee.employee_number") },
      ],
    },
    { type: "spacer", size_mm: 3 },
    matrix,
    { type: "spacer", size_mm: 3 },
    {
      type: "section",
      title: lit("End-of-Year Summary"),
      keep_together: true,
      children: [
        { type: "key_value", label: lit("Total Chargeable Pay (Col. K)"),
          value: bindFmt("totals.chargeable_pay", "currency"), emphasis: "primary" },
        { type: "key_value", label: lit("Total PAYE (Col. O)"),
          value: bindFmt("totals.paye", "currency"), emphasis: "primary" },
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
        { caption: lit("Employer Signature"), sub_caption: lit("Name, Designation, Date & Official Stamp") },
        { caption: lit("Employee Declaration"), sub_caption: lit("Signed by employee — attach with return") },
      ],
    },
  ],
};
