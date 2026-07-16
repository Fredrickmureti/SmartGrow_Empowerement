/**
 * returnToAst — compile a statutory-return body (columns + optional
 * `renderer:"v2-returns"` sections) into a country-agnostic
 * `CertificateTemplateV3`. This lets the return editor render its PDF
 * preview through the SAME HTML + CSS Paged Media pipeline the
 * certificate engine uses, retiring the hand-drawn pdf-lib renderer
 * from the preview surface (see mem://features/certificate-rendering
 * Core rule: no pdf-lib in localization previews).
 *
 * The engine stays country-agnostic — this adapter is one of the two
 * shared clients (the other is the certificate template loader). Any
 * country- or statute-specific string comes from the return template's
 * own metadata (`meta.legal_reference`, etc.) or the payload; nothing
 * is hardcoded here.
 */
import type {
  CertificateTemplateV3,
  GridColumn,
  GridHeaderCell,
  GridFooterCell,
  Node,
  Value,
  ValueFormat,
} from "../engine/types";

interface ReturnColumn {
  key: string;
  label?: string;
  source?: string;
  format?: "text" | "number" | "currency" | "date";
  width?: number;
}

interface ReturnSection {
  type: string;
  title?: string;
  body?: string;
  columns?: Array<{ key: string; header?: string; format?: string; align?: "left" | "right" | "center" }>;
}

interface ReturnBodyLike {
  columns?: ReturnColumn[];
  totals?: string[];
  reconciliation?: { rule_code?: string } | null;
  renderer?: "v2-returns" | null;
  sections?: ReturnSection[];
}

interface ReturnMetaLike {
  legal_reference?: string | null;
  regulation_citation?: string | null;
  authority_name?: string | null;
}

function text(s: string): Value { return { kind: "literal", value: s }; }
function bind(path: string, format?: ValueFormat, fallback = "—"): Value {
  return { kind: "binding", path, format, fallback };
}

function fmtToValueFormat(f: string | undefined): ValueFormat {
  switch (f) {
    case "currency": return "currency";
    case "number": return "number";
    case "date": return "date";
    default: return "text";
  }
}

function alignFor(f: string | undefined): "left" | "right" | "center" {
  return f === "currency" || f === "number" ? "right" : "left";
}

/**
 * Build a `CertificateTemplateV3` (schema_version 4) that renders the
 * return as: header banner (statutory reference), employer identity
 * strip, period band, employee grid (bound to `rows`), totals row,
 * optional reconciliation, and a signature strip.
 */
export function buildReturnAstTemplate(
  code: string,
  displayName: string,
  body: ReturnBodyLike | null | undefined,
  meta: ReturnMetaLike | null | undefined,
): CertificateTemplateV3 {
  const columns: ReturnColumn[] = Array.isArray(body?.columns) ? body!.columns : [];
  const totalsKeys: string[] = Array.isArray(body?.totals) ? body!.totals : [];
  const reconciliation = body?.reconciliation ?? null;
  const sections: ReturnSection[] = Array.isArray(body?.sections) ? body!.sections : [];
  const hasV2 = body?.renderer === "v2-returns" && sections.length > 0;

  const gridColumns: GridColumn[] = columns.map((c) => ({
    id: c.key,
    align: alignFor(c.format),
    format: fmtToValueFormat(c.format),
  }));

  const headerRow: GridHeaderCell[] = columns.map((c) => ({
    content: text(c.label ?? c.key),
    align: alignFor(c.format),
    variant: "label",
  }));

  const footerRow: GridFooterCell[] | null = totalsKeys.length
    ? columns.map((c, i): GridFooterCell => {
        if (totalsKeys.includes(c.key)) {
          return {
            content: { kind: "sum_of", column_id: c.key, format: fmtToValueFormat(c.format) },
            align: "right",
            variant: "total",
          };
        }
        return { content: text(i === 0 ? "Total" : ""), align: alignFor(c.format), variant: "total" };
      })
    : null;

  const grid: Node = {
    type: "grid",
    columns: gridColumns,
    data_rows: { bind: "rows" },
    header_rows: [headerRow],
    footer_rows: footerRow ? [footerRow] : undefined,
    repeat_header: true,
    border: "all",
  };

  const documentNodes: Node[] = [];

  // Statutory-reference banner
  const legal = meta?.legal_reference ?? null;
  if (legal) {
    documentNodes.push({
      type: "heading",
      level: 2,
      align: "center",
      text: text(legal),
    });
  }
  documentNodes.push({
    type: "heading",
    level: 1,
    align: "center",
    text: text(displayName),
  });

  // Employer identity strip (bound to payload.employer.*)
  documentNodes.push({
    type: "identity_strip",
    left_title: text("Employer"),
    right_title: text("Filing"),
    left: [
      { type: "key_value", label: text("Name"), value: bind("employer.name") },
      { type: "key_value", label: text("Tax ID"), value: bind("employer.tax_pin") },
      { type: "key_value", label: text("Address"), value: bind("employer.address") },
    ],
    right: [
      { type: "key_value", label: text("Period"), value: bind("period_label") },
      { type: "key_value", label: text("Serial"), value: bind("serial_number") },
      { type: "key_value", label: text("Generated"), value: bind("generated_at") },
    ],
  });

  // Iterate sections when v2 opted in, otherwise emit the grid directly.
  if (hasV2) {
    for (const s of sections) {
      switch (s.type) {
        case "employer_header":
          // already emitted via identity_strip above; skip
          break;
        case "period_band":
          documentNodes.push({
            type: "field_row",
            fields: [
              { type: "label_fill", label: text("Period start"), value: bind("period_start", "date") },
              { type: "label_fill", label: text("Period end"), value: bind("period_end", "date") },
              { type: "label_fill", label: text("Currency"), value: bind("currency") },
            ],
          });
          break;
        case "employee_line_grid":
          documentNodes.push(grid);
          break;
        case "totals":
          documentNodes.push({
            type: "field_row",
            fields: totalsKeys.map((k) => ({
              type: "label_fill" as const,
              label: text(k),
              value: bind(`totals.${k}`, "currency"),
            })),
          });
          break;
        case "reconciliation":
          documentNodes.push({
            type: "section",
            title: text("Reconciliation"),
            children: [
              {
                type: "field_row",
                fields: [
                  { type: "label_fill", label: text("Rule"), value: bind("reconciliation.rule_code") },
                  { type: "label_fill", label: text("Expected"), value: bind("reconciliation.expected", "currency") },
                  { type: "label_fill", label: text("Actual"), value: bind("reconciliation.actual", "currency") },
                  { type: "label_fill", label: text("Delta"), value: bind("reconciliation.delta", "currency") },
                ],
              },
            ],
          });
          break;
        case "signature":
          documentNodes.push({
            type: "signature_strip",
            slots: [
              { caption: text("Authorised signature") },
              { caption: text("Date") },
            ],
          });
          break;
        case "statutory_footnote":
          documentNodes.push({
            type: "legal_notice",
            title: s.title ? text(s.title) : undefined,
            paragraphs: (s.body ?? "").split(/\n{2,}/).map((p) => text(p)),
            border: true,
          });
          break;
        case "remittance":
          documentNodes.push({
            type: "field_row",
            fields: [
              { type: "label_fill", label: text("Payment ref"), value: bind("payment_reference") },
              { type: "label_fill", label: text("Amount"), value: bind("payment_amount", "currency") },
            ],
          });
          break;
        default:
          // Unknown section — emit a placeholder heading so the publisher
          // sees the gap rather than silent-drop.
          documentNodes.push({
            type: "heading",
            level: 3,
            text: text(s.title ?? `Section: ${s.type}`),
          });
          break;
      }
    }
  } else {
    // Non-v2: just the grid (matches non-PDF preview semantics).
    documentNodes.push(grid);
    if (reconciliation?.rule_code) {
      documentNodes.push({
        type: "section",
        title: text("Reconciliation"),
        children: [
          {
            type: "field_row",
            fields: [
              { type: "label_fill", label: text("Rule"), value: text(reconciliation.rule_code) },
              { type: "label_fill", label: text("Expected"), value: bind("reconciliation.expected", "currency") },
              { type: "label_fill", label: text("Actual"), value: bind("reconciliation.actual", "currency") },
            ],
          },
        ],
      });
    }
  }

  // Regulation citation footer
  if (meta?.regulation_citation) {
    documentNodes.push({
      type: "legal_notice",
      paragraphs: [text(meta.regulation_citation)],
      border: false,
    });
  }

  return {
    schema_version: 4,
    code,
    display_name: displayName,
    paper_format: {
      size: "A4",
      orientation: "portrait",
      margin_top: 14,
      margin_right: 12,
      margin_bottom: 14,
      margin_left: 12,
      header_height: 0,
      footer_height: 8,
    },
    document: documentNodes,
  };
}