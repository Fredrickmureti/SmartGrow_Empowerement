/**
 * Kenya P9 (Tax Deduction Card) — Certificate Engine v4 template.
 *
 * Country knowledge lives ENTIRELY in this pack-authored data. The engine
 * (compile.ts) never mentions Kenya, KRA, P9, PAYE, SHIF, NSSF, or AHL.
 * Every string is a literal on a generic node; every dynamic value is a
 * `binding` into the payload assembled by `generate-tax-certificate`.
 *
 * Layout blueprint follows KRA Appendix 2A (2025 revision):
 *   - Header stack with 4 semantic rows: label / unit / letter / sub-instr.
 *     Only the E column has a `colspan=3` label ("Defined Contribution
 *     Retirement Scheme"); E1/E2/E3 each get their own letter cell and
 *     their own sub-instruction cell — a shape that the v3 MatrixNode
 *     could not express, which is why v4 introduced GridNode.
 *   - Employer/employee identity as inline "label ......... value"
 *     fill-in lines (label_fill + field_row), NOT a two-column KV strip.
 *   - End-of-year totals as label_fill lines beside a "To be completed
 *     by employer" caption.
 *   - IMPORTANT + Attach block as a two-column `columns` container
 *     holding nested numbered lists.
 */
import type {
  CertificateTemplateV3,
  FieldRowNode,
  GridFooterCell,
  GridHeaderCell,
  GridNode,
  Node,
  Theme,
} from "../types";

const lit = (v: string | number) => ({ kind: "literal" as const, value: v });
const bind = (path: string, fallback = "") => ({ kind: "binding" as const, path, fallback });
const bindFmt = (path: string, format: any, fallback = "") =>
  ({ kind: "binding" as const, path, format, fallback });

// ── Theme ────────────────────────────────────────────────────────────
// Statutory-form aesthetic: black rules, no zebra, plain white cells
// except for the letter/unit header bands, serif body text with a
// sans-serif heading. Publishers can adjust these per pack.
const theme: Theme = {
  body_font: '"Times New Roman", "Nimbus Roman", Times, serif',
  heading_font: '"Helvetica Neue", "Arial", sans-serif',
  base_font_size_pt: 7.2,
  color: "#000",
  muted_color: "#000",
  rule_color: "#000",
  rule_weight_pt: 0.75,
  header_shade: "none",
  header_letter_shade: "none",
  header_unit_shade: "none",
  header_note_shade: "none",
  zebra: "none",
  heading_case: "none",
  heading_underline: false,
  grid_font_size_pt: 5.4,
  grid_number_font_size_pt: 5.2,
  grid_footer_font_size_pt: 5.2,
  numeric_letter_spacing: "0",
  legal_border: false,
  legal_border_color: "#000",
};

// ── Monthly Deductions grid ───────────────────────────────────────────
// Column definitions (data plane).
const columns: GridNode["columns"] = [
  { id: "month",  width: "18mm",   align: "left",  format: "month_short", nowrap: true },
  { id: "col_a",  width: "1fr",    align: "right", format: "number", source_key: "basic" },
  { id: "col_b",  width: "1fr",    align: "right", format: "number", source_key: "non_cash_benefits" },
  { id: "col_c",  width: "1fr",    align: "right", format: "number", source_key: "housing_benefit" },
  { id: "col_d",  width: "1fr",    align: "right", format: "number" },
  { id: "col_e1", width: "1fr",    align: "right", format: "number" },
  { id: "col_e2", width: "1fr",    align: "right", format: "number", source_key: "nssf" },
  { id: "col_e3", width: "1fr",    align: "right", format: "number" },
  { id: "col_f",  width: "1fr",    align: "right", format: "number", source_key: "housing_levy" },
  { id: "col_g",  width: "1fr",    align: "right", format: "number", source_key: "shif" },
  { id: "col_h",  width: "1fr",    align: "right", format: "number", source_key: "prmf" },
  { id: "col_i",  width: "1fr",    align: "right", format: "number", source_key: "mortgage_interest_relief_base" },
  { id: "col_j",  width: "1fr",    align: "right", format: "number" },
  { id: "col_k",  width: "1fr",    align: "right", format: "number" },
  { id: "col_l",  width: "1fr",    align: "right", format: "number" },
  { id: "col_m",  width: "1fr",    align: "right", format: "number", source_key: "personal_relief" },
  { id: "col_n",  width: "1fr",    align: "right", format: "number", source_key: "insurance_relief" },
  { id: "col_o",  width: "1fr",    align: "right", format: "number", source_key: "paye" },
];

const ruleCodes = [
  "basic",
  "housing_allowance",
  "transport_allowance",
  "non_cash_benefits",
  "housing_benefit",
  "nssf",
  "housing_levy",
  "shif",
  "prmf",
  "mortgage_interest_relief_base",
  "paye",
  "personal_relief",
  "insurance_relief",
];

const derivedColumns: NonNullable<GridNode["derived_columns"]> = [
  { key: "col_d", expr: "sum", args: ["col_a", "housing_allowance", "transport_allowance", "col_b", "col_c"] },
  { key: "col_e1", expr: "pct", args: ["col_a", 0.3] },
  { key: "col_e3", expr: "min", args: ["col_e1", "col_e2", 30000] },
  { key: "col_j", expr: "sum", args: ["col_e3", "col_f", "col_g", "col_h", "col_i"] },
  { key: "col_k", expr: "sub", args: ["col_d", "col_j"] },
  { key: "col_l", expr: "sum", args: ["col_o", "col_m", "col_n"] },
];

// Header stack — 4 rows. Cell-level colspan/rowspan mirrors the KRA form.
//
// Row 1 (label): MONTH (rowspan 4), Basic Salary, …
//                Defined Contribution Retirement Scheme (colspan 3), …
//                Total Deductions, …
// Row 2 (unit):  Kshs. under every amount column except MONTH.
// Row 3 (letter): A B C D | E1 E2 E3 | F G H I J K L M N O
// Row 4 (note):   only under E1/E2/E3 → "30% of A" / "Actual" / "Fixed 30,000 p.m"
//
// Note: the official form has a visible currency band across all amount
//   columns. Do not rowspan ordinary labels over that unit row; otherwise
//   `Kshs.` only appears under the E1/E2/E3 grouped columns.

const headerRow_LabelUnit: GridHeaderCell[] = [
  { content: lit("MONTH"),                    row_span: 4, variant: "label", align: "center" },
  { content: lit("Basic Salary"),             variant: "label" },
  { content: lit("Benefits – Non-Cash"),      variant: "label" },
  { content: lit("Value of Quarters"),        variant: "label" },
  { content: lit("Total Gross Pay"),          variant: "label" },
  { content: lit("Defined Contribution Retirement Scheme"), span: 3, variant: "label" },
  { content: lit("Affordable Housing Levy (AHL)"), variant: "label" },
  { content: lit("Social Health Insurance Fund (SHIF)"), variant: "label" },
  { content: lit("Post Retirement Medical Fund (PRMF)"), variant: "label" },
  { content: lit("Owner-Occupied Interest"),  variant: "label" },
  { content: lit("Total Deductions (Lower of E+F+G+H+I)"), variant: "label" },
  { content: lit("Chargeable Pay (D–J)"),     variant: "label" },
  { content: lit("Tax Charged"),              variant: "label" },
  { content: lit("Personal Relief"),          variant: "label" },
  { content: lit("Insurance Relief"),         variant: "label" },
  { content: lit("PAYE Tax (L-M-N)"),         variant: "label" },
];

// Row 2 — the "Kshs." unit for every amount column A–O.
const headerRow_Unit: GridHeaderCell[] = [
  // MONTH continues via rowspan
  ...Array.from({ length: 17 }, () => ({ content: lit("Kshs."), variant: "unit" as const, align: "center" as const })),
];

// Row 3 — letter row: A B C D | E1 E2 E3 | F G H I J K L M N O
const headerRow_Letters: GridHeaderCell[] = [
  // MONTH continues via rowspan
  { content: lit("A"),  variant: "letter", align: "center" },
  { content: lit("B"),  variant: "letter", align: "center" },
  { content: lit("C"),  variant: "letter", align: "center" },
  { content: lit("D"),  variant: "letter", align: "center" },
  { content: lit("E1"), variant: "letter", align: "center" },
  { content: lit("E2"), variant: "letter", align: "center" },
  { content: lit("E3"), variant: "letter", align: "center" },
  { content: lit("F"),  variant: "letter", align: "center" },
  { content: lit("G"),  variant: "letter", align: "center" },
  { content: lit("H"),  variant: "letter", align: "center" },
  { content: lit("I"),  variant: "letter", align: "center" },
  { content: lit("J"),  variant: "letter", align: "center" },
  { content: lit("K"),  variant: "letter", align: "center" },
  { content: lit("L"),  variant: "letter", align: "center" },
  { content: lit("M"),  variant: "letter", align: "center" },
  { content: lit("N"),  variant: "letter", align: "center" },
  { content: lit("O"),  variant: "letter", align: "center" },
];

// Row 4 — sub-instructions row: only cells under E1/E2/E3 carry text.
const headerRow_Notes: GridHeaderCell[] = [
  // MONTH continues via rowspan
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit("30% of A"),        variant: "note", align: "center" },
  { content: lit("Actual"),          variant: "note", align: "center" },
  { content: lit("Fixed 30,000 p.m"), variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
  { content: lit(""),                variant: "note", align: "center" },
];

// Footer: TOTAL row summing every numeric column.
const totalRow: GridFooterCell[] = [
  { content: lit("TOTAL"), align: "left", variant: "total" },
  ...(["col_a", "col_b", "col_c", "col_d", "col_e1", "col_e2", "col_e3",
       "col_f", "col_g", "col_h", "col_i", "col_j", "col_k", "col_l",
       "col_m", "col_n", "col_o"] as const).map<GridFooterCell>((id) => ({
    content: { kind: "sum_of" as const, column_id: id, format: "number" as const },
    align: "right",
    variant: "total",
  })),
];

const grid: GridNode = {
  type: "grid",
  columns,
  rule_codes: ruleCodes,
  derived_columns: derivedColumns,
  amount_field: "employee_amount",
  header_rows: [headerRow_LabelUnit, headerRow_Unit, headerRow_Letters, headerRow_Notes],
  data_rows: { bind: "p9.months" },
  footer_rows: [totalRow],
  repeat_header: true,
  border: "all",
  zebra: "none",
};

// ── Identity fields (inline label-fill lines) ─────────────────────────
const identityRow1: FieldRowNode = {
  type: "field_row",
  gap_mm: 6,
  columns: ["1fr", "0.6fr"],
  fields: [
    { type: "label_fill", label: lit("Employer's Name"),  value: bind("employer.name"),         rule: "dotted", label_bold: true },
    { type: "label_fill", label: lit("Employer's PIN"),   value: bind("employer.tax_pin"),      rule: "dotted", label_bold: true, emphasis: "primary" },
  ],
};
const identityRow2: FieldRowNode = {
  type: "field_row",
  gap_mm: 6,
  columns: ["1fr", "0.6fr"],
  fields: [
    { type: "label_fill", label: lit("Employee's Main Name"), value: bind("employee.full_name"), rule: "dotted", label_bold: true },
    { type: "label_fill", label: lit("Employee's PIN"),       value: bind("employee.tax_pin"),   rule: "dotted", label_bold: true, emphasis: "primary" },
  ],
};
const identityRow3: FieldRowNode = {
  type: "field_row",
  gap_mm: 6,
  columns: ["1fr"],
  fields: [
    { type: "label_fill", label: lit("Employee's Other Names"), value: bind("employee.other_names"), rule: "dotted", label_bold: true },
  ],
};

// ── End-of-year fill-in row ───────────────────────────────────────────
const endOfYearRow: FieldRowNode = {
  type: "field_row",
  gap_mm: 8,
  columns: ["1fr", "1fr"],
  fields: [
    { type: "label_fill", label: lit("TOTAL CHARGEABLE PAY (COL. K)  Kshs."), value: bindFmt("totals.chargeable_pay", "number"), rule: "dotted", label_bold: true, emphasis: "primary" },
    { type: "label_fill", label: lit("TOTAL TAX (COL. O)  Kshs."),            value: bindFmt("totals.paye", "number"),           rule: "dotted", label_bold: true, emphasis: "primary" },
  ],
};

// ── IMPORTANT + Attach two-column notice ──────────────────────────────
const importantList: Node = {
  type: "list",
  marker: "decimal",
  compact: true,
  items: [
    {
      text: lit("Use P9A"),
      children: {
        type: "list",
        marker: "lower-alpha-paren",
        compact: true,
        items: [
          { text: lit("For all liable employees and where director/employee received Benefits in addition to cash emoluments") },
          { text: lit("Where an employee is eligible to deduction on owner occupier interest.") },
          { text: lit("Where an employee contributes to a post retirement medical fund") },
        ],
      },
    },
    {
      text: lit(""),
      children: {
        type: "list",
        marker: "lower-alpha-paren",
        compact: true,
        items: [
          { text: lit("Deductible interest in respect of any month prior to December 2024 must not exceed Kshs. 25,000/= and commencing December 2024 must not exceed 30,000/=") },
          { text: lit("Deductible pension contribution in respect of any month prior to December 2024 must not exceed Kshs. 20,000/= and commencing December 2024 must not exceed 30,000/=") },
          { text: lit("Deductible contribution to a post retirement medical fund in respect of any month is effective from December 2024, must not exceed Kshs.15,000/=") },
          { text: lit("Deductible Contribution to the Social Health Insurance Fund (SHIF) and deductions made towards Affordable Housing Levy (AHL) are effective December 2024") },
          { text: lit("Personal Relief is Kshs. 2,400 per Month or 28,800 per year") },
          { text: lit("Insurance Relief is 15% of the Premium up to a Maximum of Kshs. 5,000 per month or Kshs. 60,000 per year") },
        ],
      },
    },
  ],
};

const attachList: Node = {
  type: "list",
  marker: "lower-alpha-paren",
  compact: true,
  start: 3, // continues the (c) enumeration from the KRA form
  items: [
    {
      text: lit("Attach"),
      children: {
        type: "list",
        marker: "lower-roman-paren",
        compact: true,
        items: [
          { text: lit("Photostat copy of interest certificate and statement of account from the Financial Institution") },
          { text: lit("The DECLARATION duly signed by the employee.") },
        ],
      },
    },
  ],
};

const importantBlock: Node = {
  type: "section",
  keep_together: false,
  children: [
    {
      type: "rich_text",
      paragraphs: [[{ text: lit("IMPORTANT"), emphasis: "bold" }]],
    },
    {
      type: "columns",
      count: 2,
      gap_mm: 8,
      column_children: [
        [importantList],
        [attachList],
      ],
    },
    {
      type: "rich_text",
      paragraphs: [[{ text: lit("P9A"), emphasis: "bold" }]],
    },
  ],
};

// First-page statutory heading. This belongs in normal document flow rather
// than a Paged Media running header: the official P9 shows it once at the top
// of the form, and running margin boxes can clip tall header stacks in print.
const topHeader: Node = {
  type: "columns",
  count: 3,
  gap_mm: 4,
  column_children: [
    [
      {
        type: "rich_text",
        align: "left",
        paragraphs: [[{ text: lit("APPENDIX 2A"), emphasis: "bold" }]],
      },
    ],
    [
      { type: "heading", level: 2, align: "center", text: lit("KENYA REVENUE AUTHORITY DOMESTIC TAXES DEPARTMENT") },
      { type: "rich_text", align: "center", paragraphs: [[{ text: lit("TAX DEDUCTION CARD"), emphasis: "bold" }]] },
      {
        type: "rich_text",
        align: "center",
        paragraphs: [[
          { text: lit("YEAR "), emphasis: "muted" },
          { text: bind("fiscal_year", "20 ......") },
        ]],
      },
    ],
    [
      {
        type: "rich_text",
        align: "right",
        paragraphs: [[{ text: lit("ISO 9001:2015 CERTIFIED"), emphasis: "muted" }]],
      },
    ],
  ],
};

// ── Template envelope ────────────────────────────────────────────────
export const KE_P9_V3_TEMPLATE: CertificateTemplateV3 = {
  schema_version: 4,
  code: "P9",
  display_name: "Kenya — Tax Deduction Card (P9)",
  theme,
  paper_format: {
    size: "A4",
    orientation: "landscape",
    margin_top: 6,
    margin_right: 10,
    margin_bottom: 8,
    margin_left: 10,
    header_height: 0,
    footer_height: 6,
  },
  page_master: {
    code: "ke.p9.page_master.v12",
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
    topHeader,
    // Identity block: inline label ......... value fill-in lines
    identityRow1,
    identityRow2,
    identityRow3,
    { type: "spacer", size_mm: 1 },
    // Monthly deductions grid
    grid,
    { type: "spacer", size_mm: 1 },
    // "To be completed by Employer at end of year" caption + fill-in totals
    {
      type: "rich_text",
      paragraphs: [[{ text: lit("To be completed by Employer at end of year"), emphasis: "italic" }]],
    },
    endOfYearRow,
    { type: "spacer", size_mm: 1 },
    // IMPORTANT + Attach two-column notice with nested numbered lists
    importantBlock,
  ],
};
