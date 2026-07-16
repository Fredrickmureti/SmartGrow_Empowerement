/**
 * returnToAst — compile a statutory-return body (columns + totals +
 * optional reconciliation) into a country-agnostic
 * `CertificateTemplateV3`. This lets the return editor render its PDF
 * preview through the SAME HTML + CSS Paged Media pipeline the
 * certificate engine uses; the legacy pdf-lib section renderer (the
 * old `renderer:"v2-returns"` opt-in) has been retired.
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

interface ReturnBodyLike {
  columns?: ReturnColumn[];
  totals?: string[];
  reconciliation?: { rule_code?: string } | null;
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

  // Tabular return: grid + optional reconciliation block.
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