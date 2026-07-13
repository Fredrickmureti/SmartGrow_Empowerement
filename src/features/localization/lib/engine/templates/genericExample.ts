/**
 * Country-agnostic example certificate template.
 *
 * Used only as the "Seed from example" starter in the publisher editor.
 * Deliberately generic — no jurisdiction, statute, regulator or currency
 * knowledge. All country/statutory content lives in country-specific packs
 * (per-jurisdiction pack files under `templates/`). The engine + editor must
 * stay ignorant of any specific filing.
 */
import type { CertificateTemplateV3 } from "../types";

const lit = (v: string | number) => ({ kind: "literal" as const, value: v });
const bind = (path: string, fallback = "") => ({ kind: "binding" as const, path, fallback });

export const GENERIC_EXAMPLE_TEMPLATE: CertificateTemplateV3 = {
  schema_version: 4,
  code: "example.certificate",
  display_name: "Example Certificate",
  paper_format: {
    size: "A4",
    orientation: "portrait",
    margin_top: 14,
    margin_right: 12,
    margin_bottom: 12,
    margin_left: 12,
    header_height: 12,
    footer_height: 10,
  },
  page_master: {
    code: "example.page_master.v1",
    header: [
      { type: "heading", level: 1, align: "center", text: lit("Certificate") },
    ],
    footer: [
      { type: "rich_text", align: "center",
        paragraphs: [[{ text: lit("Page footer") }]] },
    ],
  },
  document: [
    { type: "heading", level: 2, align: "left", text: lit("Recipient") },
    { type: "field_row", gap_mm: 6, fields: [
      { type: "label_fill", label: lit("Employer:"), value: bind("employer.name"), rule: "dotted" },
      { type: "label_fill", label: lit("Employee:"), value: bind("employee.full_name"), rule: "dotted" },
    ] },
    { type: "spacer", size_mm: 3 },
    { type: "grid",
      title: lit("Monthly summary"),
      columns: [
        { id: "month",  width: "20mm", align: "left",  format: "text",   nowrap: true },
        { id: "gross",  width: "1fr",  align: "right", format: "number" },
        { id: "tax",    width: "1fr",  align: "right", format: "number" },
      ],
      header_rows: [[
        { span: 1, content: lit("Month"),  variant: "label", align: "left"  },
        { span: 1, content: lit("Gross"),  variant: "label", align: "right" },
        { span: 1, content: lit("Tax"),    variant: "label", align: "right" },
      ]],
      data_rows: { bind: "rows.items" },
      footer_rows: [[
        { span: 1, content: lit("TOTAL"), variant: "total", align: "left"  },
        { span: 1, content: { kind: "sum_of", column_id: "gross" } as any, variant: "total", align: "right" },
        { span: 1, content: { kind: "sum_of", column_id: "tax"   } as any, variant: "total", align: "right" },
      ]],
      repeat_header: true,
      border: "all",
      zebra: "none",
    },
    { type: "spacer", size_mm: 6 },
    { type: "signature_strip", slots: [
      { caption: lit("Signature"), sub_caption: lit("Authorised signatory") },
      { caption: lit("Date") },
    ] },
  ],
  theme: undefined,
};
