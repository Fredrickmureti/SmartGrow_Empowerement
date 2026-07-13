// @ts-nocheck — Deno runtime
/**
 * Certificate Engine — AST → HTML + CSS Paged Media compiler
 * (browser mirror of supabase/functions/_shared/certificate-engine/compile.ts).
 *
 * Deterministic: same (template, payload) always produces the same HTML.
 * Emits a single self-contained HTML document with an inline stylesheet
 * built from the pack-owned `theme` (with ENGINE_DEFAULT_THEME as fallback).
 * The engine ships pagination/layout primitives; it ships NO country
 * knowledge and — as of v4 — no presentation policy beyond safe defaults
 * that a pack can override wholesale.
 */
import {
  ENGINE_DEFAULT_THEME,
  type CertificatePayload,
  type CertificateTemplateV3,
  type ColumnsNode,
  type FieldRowNode,
  type GridFooterCell,
  type GridHeaderCell,
  type GridNode,
  type IdentityStripNode,
  type ImageNode,
  type KeyValueNode,
  type LabelFillNode,
  type LegalNoticeNode,
  type ListItem,
  type ListNode,
  type MatrixNode,
  type Node,
  type PaperFormat,
  type SectionNode,
  type SignatureStripNode,
  type Theme,
  type Value,
} from "./types.ts";
import {
  createContext,
  formatValue,
  readRows,
  resolveValue,
  sumColumn,
  type ResolveContext,
} from "./resolver.ts";

export interface CompileResult {
  html: string;
  css: string;
  unresolved: string[];
}

export interface CompileOptions {
  currency?: string;
  locale?: string;
}

export function compile(
  template: CertificateTemplateV3,
  payload: CertificatePayload,
  opts: CompileOptions = {},
): CompileResult {
  const ctx = createContext(payload, opts);
  const theme = mergeTheme(template.theme);
  const css = buildCss(template.paper_format, theme);
  // Wrap every top-level document/page-master node with a `data-ce-node`
  // marker so the editor's live preview can attribute clicks back to the
  // AST index (WYSIWYG click-to-select bridge). Purely structural — the
  // marker div carries no styling and does not affect layout.
  //
  // Additionally, mark nodes whose text is a pure literal (no bindings)
  // as `data-ce-editable="<type>"` — the iframe bridge lets a publisher
  // double-click to edit that text inline. Bindings are left untouched
  // because inline-editing a bound value would silently detach it from
  // its payload path.
  const editableFlag = (n: any): string => {
    if (n?.type === "heading" && n?.text?.kind === "literal") return ` data-ce-editable="heading"`;
    if (n?.type === "rich_text" && Array.isArray(n?.paragraphs) && n.paragraphs.length === 1
        && Array.isArray(n.paragraphs[0]) && n.paragraphs[0].length === 1
        && n.paragraphs[0][0]?.text?.kind === "literal") return ` data-ce-editable="rich_text"`;
    return "";
  };
  const wrap = (nodes: Node[], scope: string) =>
    nodes.map((n, i) =>
      `<div data-ce-node="${scope}.${i}" data-ce-type="${(n as any).type}"${editableFlag(n)}>${renderNode(n, ctx)}</div>`,
    ).join("\n");
  const body = wrap(template.document, "doc");
  const header = template.page_master?.header
    ? `<div class="page-header">${wrap(template.page_master.header, "hdr")}</div>`
    : "";
  const footer = template.page_master?.footer
    ? `<div class="page-footer">${wrap(template.page_master.footer, "ftr")}</div>`
    : "";

  const html =
`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(template.display_name)}</title>
<style>${css}</style>
</head>
<body>
${header}
${footer}
<main class="document">
${body}
</main>
</body>
</html>`;

  return { html, css, unresolved: [...ctx.unresolved].sort() };
}

// ── Theme merging ─────────────────────────────────────────────────────

function mergeTheme(theme: Theme | undefined): Required<Theme> {
  return { ...ENGINE_DEFAULT_THEME, ...(theme ?? {}) };
}

// ── CSS ───────────────────────────────────────────────────────────────

function buildCss(pf: PaperFormat, t: Required<Theme>): string {
  const size = `${pf.size} ${pf.orientation}`;
  const zebraSel = t.zebra === "none" ? "none-selector-never-matches" :
    t.zebra === "odd" ? "tbody tr:nth-child(odd) td" : "tbody tr:nth-child(even) td";
  return `
:root {
  --ce-body-font: ${t.body_font};
  --ce-heading-font: ${t.heading_font};
  --ce-base-size: ${t.base_font_size_pt}pt;
  --ce-color: ${t.color};
  --ce-muted: ${t.muted_color};
  --ce-rule: ${t.rule_color};
  --ce-rule-w: ${t.rule_weight_pt}pt;
  --ce-head-shade: ${cssShade(t.header_shade)};
  --ce-head-letter-shade: ${cssShade(t.header_letter_shade)};
  --ce-head-unit-shade: ${cssShade(t.header_unit_shade)};
  --ce-head-note-shade: ${cssShade(t.header_note_shade)};
  --ce-zebra: ${t.zebra_color};
  --ce-grid-size: ${t.grid_font_size_pt}pt;
  --ce-grid-num-size: ${t.grid_number_font_size_pt}pt;
  --ce-grid-foot-size: ${t.grid_footer_font_size_pt}pt;
  --ce-num-letter-spacing: ${t.numeric_letter_spacing};
  --ce-legal-border: ${t.legal_border_color};
}
@page {
  size: ${size};
  margin: ${pf.margin_top}mm ${pf.margin_right}mm ${pf.margin_bottom}mm ${pf.margin_left}mm;
  @top-center { content: element(pageHeader); }
  @bottom-center { content: element(pageFooter); }
}
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--ce-body-font);
  font-size: var(--ce-base-size);
  color: var(--ce-color);
  line-height: 1.35;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.page-header { position: running(pageHeader); }
.page-footer { position: running(pageFooter); font-size: 8pt; color: var(--ce-muted); }
.document { }
h1.ce-h, h2.ce-h, h3.ce-h { font-family: var(--ce-heading-font); font-weight: 700; ${t.heading_case === "upper" ? "text-transform: uppercase;" : t.heading_case === "capitalize" ? "text-transform: capitalize;" : ""} ${t.heading_underline ? "text-decoration: underline;" : ""} }
h1.ce-h { font-size: 13pt; margin: 0 0 3pt 0; letter-spacing: 0.01em; }
h2.ce-h { font-size: 11pt; margin: 3pt 0 3pt 0; letter-spacing: 0.02em; }
h3.ce-h { font-size: 10pt; margin: 6pt 0 3pt 0; }
.ce-align-left   { text-align: left; }
.ce-align-center { text-align: center; }
.ce-align-right  { text-align: right; }
.ce-section { margin-bottom: 8pt; }
.ce-section-title { font-size: 10pt; font-weight: 700; margin: 6pt 0 3pt 0; border-bottom: var(--ce-rule-w) solid var(--ce-rule); padding-bottom: 1pt; }
.ce-keep-together { break-inside: avoid; page-break-inside: avoid; }
.ce-kv { display: flex; gap: 6pt; margin: 1pt 0; }
.ce-kv-label { color: var(--ce-muted); min-width: 34mm; }
.ce-kv-value { color: var(--ce-color); font-weight: 500; }
.ce-kv-primary .ce-kv-value { font-weight: 700; }
.ce-identity { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; margin: 4pt 0 8pt 0; }
.ce-identity-col-title { font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 2pt; border-bottom: var(--ce-rule-w) solid var(--ce-rule); padding-bottom: 1pt; }
.ce-para { margin: 3pt 0; }
.ce-em-bold { font-weight: 700; }
.ce-em-italic { font-style: italic; }
.ce-em-muted { color: var(--ce-muted); }

/* Legacy MatrixNode (schema_version 3). */
.ce-matrix-wrap { margin: 4pt 0 8pt 0; }
.ce-matrix-title { font-size: 10pt; font-weight: 700; margin-bottom: 2pt; }
.ce-matrix { width: 100%; border-collapse: collapse; table-layout: fixed; }
.ce-matrix thead { display: table-header-group; }
.ce-matrix tfoot { display: table-footer-group; }
.ce-matrix th, .ce-matrix td {
  border: var(--ce-rule-w) solid var(--ce-rule);
  padding: 1.5pt 2.5pt;
  font-size: var(--ce-grid-size);
  vertical-align: middle;
  word-break: break-word;
  overflow-wrap: anywhere;
  hyphens: auto;
}
.ce-matrix thead th { background: var(--ce-head-shade); font-weight: 700; text-align: center; line-height: 1.1; }
.ce-matrix thead th.ce-group { background: var(--ce-head-letter-shade); text-transform: uppercase; letter-spacing: 0.02em; font-size: 6.5pt; }
.ce-matrix thead th.ce-unit { background: var(--ce-head-unit-shade); font-weight: 500; font-style: italic; color: var(--ce-muted); }
.ce-matrix thead th.ce-letter { background: var(--ce-head-letter-shade); font-weight: 700; }
.ce-matrix tfoot td { background: var(--ce-head-shade); font-weight: 700; }
.ce-matrix td.num, .ce-matrix tfoot td.num { white-space: nowrap; font-size: var(--ce-grid-num-size); word-break: normal; overflow-wrap: normal; letter-spacing: var(--ce-num-letter-spacing); }
.ce-matrix tfoot td.num { font-size: var(--ce-grid-foot-size); letter-spacing: -0.2pt; }
.ce-matrix .num { text-align: right; font-variant-numeric: tabular-nums; }
.ce-matrix .ctr { text-align: center; }
.ce-matrix .lft { text-align: left; }
.ce-matrix ${zebraSel} { background: var(--ce-zebra); }

/* v4 GridNode. */
.ce-grid-wrap { margin: 4pt 0 8pt 0; }
.ce-grid-title { font-size: 10pt; font-weight: 700; margin-bottom: 2pt; }
.ce-grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
.ce-grid thead { display: table-header-group; }
.ce-grid tfoot { display: table-footer-group; }
.ce-grid th, .ce-grid td {
  border: var(--ce-rule-w) solid var(--ce-rule);
  padding: 1.5pt 2.5pt;
  font-size: var(--ce-grid-size);
  vertical-align: middle;
  line-height: 1.15;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.ce-grid.ce-border-outer th, .ce-grid.ce-border-outer td { border-left: 0; border-right: 0; }
.ce-grid.ce-border-none th, .ce-grid.ce-border-none td { border: 0; }
.ce-grid thead th { font-weight: 700; text-align: center; }
.ce-grid thead th.ce-h-label   { background: var(--ce-head-shade); }
.ce-grid thead th.ce-h-unit    { background: var(--ce-head-unit-shade); font-weight: 500; font-style: italic; color: var(--ce-muted); }
.ce-grid thead th.ce-h-letter  { background: var(--ce-head-letter-shade); font-weight: 700; }
.ce-grid thead th.ce-h-note    { background: var(--ce-head-note-shade); font-weight: 400; font-style: italic; font-size: 6pt; color: var(--ce-muted); }
.ce-grid thead th.ce-h-plain   { background: transparent; font-weight: 500; }
.ce-grid tfoot td { background: var(--ce-head-shade); font-weight: 700; }
.ce-grid tfoot td.ce-h-total { font-weight: 700; }
.ce-grid td.num, .ce-grid tfoot td.num { white-space: nowrap; font-size: var(--ce-grid-num-size); word-break: normal; overflow-wrap: normal; letter-spacing: var(--ce-num-letter-spacing); font-variant-numeric: tabular-nums; text-align: right; }
.ce-grid tfoot td.num { font-size: var(--ce-grid-foot-size); }
.ce-grid .num { text-align: right; font-variant-numeric: tabular-nums; }
.ce-grid .ctr { text-align: center; }
.ce-grid .lft { text-align: left; }
.ce-grid td.ce-nowrap { white-space: nowrap; }
.ce-grid.ce-zebra-even tbody tr:nth-child(even) td { background: var(--ce-zebra); }
.ce-grid.ce-zebra-odd tbody tr:nth-child(odd) td { background: var(--ce-zebra); }

/* v4 LabelFillNode + FieldRowNode. */
.ce-fill { display: inline-flex; align-items: baseline; gap: 4pt; margin: 1pt 0; min-width: 0; }
.ce-fill-label { color: var(--ce-color); white-space: nowrap; }
.ce-fill-label.ce-bold { font-weight: 700; }
.ce-fill-value { display: inline-block; min-width: 40mm; padding: 0 2pt 1pt 2pt; color: var(--ce-color); font-weight: 500; }
.ce-fill.ce-primary .ce-fill-value { font-weight: 700; }
.ce-fill-rule-dotted .ce-fill-value { border-bottom: var(--ce-rule-w) dotted var(--ce-rule); }
.ce-fill-rule-solid  .ce-fill-value { border-bottom: var(--ce-rule-w) solid  var(--ce-rule); }
.ce-fill-rule-dashed .ce-fill-value { border-bottom: var(--ce-rule-w) dashed var(--ce-rule); }
.ce-field-row { display: grid; align-items: baseline; margin: 1pt 0 2pt 0; }

/* v4 ListNode. */
.ce-list { padding-left: 6mm; margin: 3pt 0; }
.ce-list.ce-list-compact { margin: 1pt 0; }
.ce-list.ce-list-compact li { margin: 0.5pt 0; }
.ce-list li { margin: 1pt 0; }
.ce-list.ce-marker-decimal        { list-style-type: decimal; }
.ce-list.ce-marker-lower-alpha    { list-style-type: lower-alpha; }
.ce-list.ce-marker-upper-alpha    { list-style-type: upper-alpha; }
.ce-list.ce-marker-lower-roman    { list-style-type: lower-roman; }
.ce-list.ce-marker-upper-roman    { list-style-type: upper-roman; }
.ce-list.ce-marker-disc           { list-style-type: disc; }
.ce-list.ce-marker-circle         { list-style-type: circle; }
.ce-list.ce-marker-square         { list-style-type: square; }
.ce-list.ce-marker-none           { list-style-type: none; padding-left: 0; }
/* Custom marker styles use CSS counters for parenthesised markers. */
.ce-list.ce-marker-decimal-paren       { list-style: none; counter-reset: cel; padding-left: 8mm; }
.ce-list.ce-marker-decimal-paren > li  { counter-increment: cel; position: relative; }
.ce-list.ce-marker-decimal-paren > li::before { content: counter(cel) ")"; position: absolute; left: -8mm; width: 7mm; text-align: right; padding-right: 1mm; }
.ce-list.ce-marker-lower-alpha-paren   { list-style: none; counter-reset: cel; padding-left: 8mm; }
.ce-list.ce-marker-lower-alpha-paren > li { counter-increment: cel; position: relative; }
.ce-list.ce-marker-lower-alpha-paren > li::before { content: "(" counter(cel, lower-alpha) ")"; position: absolute; left: -8mm; width: 7mm; text-align: right; padding-right: 1mm; }
.ce-list.ce-marker-lower-roman-paren   { list-style: none; counter-reset: cel; padding-left: 8mm; }
.ce-list.ce-marker-lower-roman-paren > li { counter-increment: cel; position: relative; }
.ce-list.ce-marker-lower-roman-paren > li::before { content: "(" counter(cel, lower-roman) ")"; position: absolute; left: -8mm; width: 7mm; text-align: right; padding-right: 1mm; }

/* v4 ColumnsNode. */
.ce-columns { display: grid; margin: 3pt 0; }

/* Legal notice. */
.ce-legal { margin: 8pt 0; padding: 5pt 7pt; break-inside: avoid; }
.ce-legal.bordered { border: var(--ce-rule-w) solid var(--ce-legal-border); }
.ce-legal-title { font-weight: 700; margin-bottom: 3pt; text-transform: uppercase; letter-spacing: 0.03em; text-decoration: underline; }
.ce-legal .ce-para { margin: 2pt 0; }
.ce-signature { display: grid; gap: 10mm; margin-top: 16pt; break-inside: avoid; page-break-inside: avoid; }
.ce-signature-slot { border-top: var(--ce-rule-w) solid var(--ce-color); padding-top: 3pt; font-size: 8.5pt; font-weight: 600; }
.ce-signature-sub { color: var(--ce-muted); font-weight: 400; margin-top: 1pt; }
.ce-image { display: block; }
.ce-image.center { margin: 0 auto; }
.ce-image.right  { margin-left: auto; }
.ce-page-break { break-before: page; page-break-before: always; }
`.trim();
}

function cssShade(v: string | "none"): string {
  return v === "none" ? "transparent" : v;
}

// ── Nodes ─────────────────────────────────────────────────────────────

function renderNode(node: Node, ctx: ResolveContext): string {
  switch (node.type) {
    case "heading":         return renderHeading(node, ctx);
    case "rich_text":       return renderRichText(node, ctx);
    case "key_value":       return renderKeyValue(node, ctx);
    case "identity_strip":  return renderIdentityStrip(node, ctx);
    case "section":         return renderSection(node, ctx);
    case "matrix":          return renderMatrix(node, ctx);
    case "legal_notice":    return renderLegal(node, ctx);
    case "signature_strip": return renderSignature(node, ctx);
    case "spacer":          return `<div style="height:${node.size_mm}mm"></div>`;
    case "image":           return renderImage(node);
    case "grid":            return renderGrid(node, ctx);
    case "list":            return renderList(node, ctx);
    case "label_fill":      return renderLabelFill(node, ctx);
    case "field_row":       return renderFieldRow(node, ctx);
    case "columns":         return renderColumns(node, ctx);
    case "page_break":      return `<div class="ce-page-break"></div>`;
    default:                return "";
  }
}

function renderHeading(n: Extract<Node, { type: "heading" }>, ctx: ResolveContext) {
  const tag = `h${n.level}`;
  return `<${tag} class="ce-h ce-align-${n.align ?? "left"}">${esc(resolveValue(n.text, ctx))}</${tag}>`;
}

function renderRichText(n: Extract<Node, { type: "rich_text" }>, ctx: ResolveContext) {
  const align = `ce-align-${n.align ?? "left"}`;
  return n.paragraphs.map((runs) => {
    const inner = runs.map((r) => {
      const cls = r.emphasis ? ` class="ce-em-${r.emphasis}"` : "";
      return `<span${cls}>${esc(resolveValue(r.text, ctx))}</span>`;
    }).join("");
    return `<p class="ce-para ${align}">${inner}</p>`;
  }).join("");
}

function renderKeyValue(n: KeyValueNode, ctx: ResolveContext) {
  const cls = n.emphasis === "primary" ? "ce-kv ce-kv-primary" : "ce-kv";
  return `<div class="${cls}"><div class="ce-kv-label">${esc(resolveValue(n.label, ctx))}</div><div class="ce-kv-value">${esc(resolveValue(n.value, ctx))}</div></div>`;
}

function renderIdentityStrip(n: IdentityStripNode, ctx: ResolveContext) {
  const col = (title: Value | undefined, items: KeyValueNode[]) => {
    const head = title ? `<div class="ce-identity-col-title">${esc(resolveValue(title, ctx))}</div>` : "";
    const body = items.map((kv) => renderKeyValue(kv, ctx)).join("");
    return `<div class="ce-identity-col">${head}${body}</div>`;
  };
  return `<div class="ce-identity">${col(n.left_title, n.left)}${col(n.right_title, n.right)}</div>`;
}

function renderSection(n: SectionNode, ctx: ResolveContext) {
  const cls = `ce-section${n.keep_together ? " ce-keep-together" : ""}`;
  const title = n.title ? `<div class="ce-section-title">${esc(resolveValue(n.title, ctx))}</div>` : "";
  const body = n.children.map((c) => renderNode(c, ctx)).join("\n");
  return `<section class="${cls}">${title}${body}</section>`;
}

function renderMatrix(n: MatrixNode, ctx: ResolveContext): string {
  const rows = readRows(n.rows_binding, ctx);
  const title = n.title ? `<div class="ce-matrix-title">${esc(resolveValue(n.title, ctx))}</div>` : "";

  const colgroup = `<colgroup>${n.columns.map((c) => {
    if (typeof c.width === "number") return `<col style="width:${c.width}mm">`;
    if (typeof c.width === "string" && c.width !== "auto") return `<col style="width:${c.width}">`;
    return `<col>`;
  }).join("")}</colgroup>`;

  const groupRow = n.column_groups?.length
    ? `<tr>${n.column_groups.map((g) => `<th colspan="${g.span}" class="ce-group">${esc(resolveValue(g.label, ctx))}</th>`).join("")}</tr>`
    : "";

  const headRow = `<tr>${n.columns.map((c) =>
    `<th class="${alignClass(c.align ?? "center")}">${esc(resolveValue(c.header, ctx))}</th>`).join("")}</tr>`;

  const hasUnit = n.columns.some((c) => c.unit);
  const unitRow = hasUnit
    ? `<tr>${n.columns.map((c) =>
        `<th class="ce-unit ${alignClass(c.align ?? "center")}">${c.unit ? esc(resolveValue(c.unit, ctx)) : ""}</th>`).join("")}</tr>`
    : "";

  const hasSub = n.columns.some((c) => c.sub_header);
  const subRow = hasSub
    ? `<tr>${n.columns.map((c) =>
        `<th class="ce-letter ${alignClass(c.align ?? "center")}">${c.sub_header ? esc(resolveValue(c.sub_header, ctx)) : ""}</th>`).join("")}</tr>`
    : "";

  const bodyRows = rows.map((row) => {
    return `<tr>${n.columns.map((c) => {
      const cellRaw = (row as any)[c.key];
      const rendered = cellRaw == null
        ? ""
        : (c.format ? formatValue(cellRaw, c.format, ctx) : String(cellRaw));
      return `<td class="${alignClass(c.align)}">${esc(rendered)}</td>`;
    }).join("")}</tr>`;
  }).join("");

  let footRow = "";
  if (n.footer) {
    const cells = n.columns.map((c, i) => {
      if (i === 0 && !n.footer!.sum_columns.includes(c.key)) {
        return `<td class="${alignClass(c.align ?? "left")}">${esc(resolveValue(n.footer!.label, ctx))}</td>`;
      }
      if (n.footer!.sum_columns.includes(c.key)) {
        const total = sumColumn(rows, c.key);
        const rendered = formatValue(total, c.format ?? "number", ctx);
        return `<td class="${alignClass(c.align ?? "right")}">${esc(rendered)}</td>`;
      }
      return `<td></td>`;
    }).join("");
    footRow = `<tr>${cells}</tr>`;
  }

  const thead = `<thead>${groupRow}${headRow}${unitRow}${subRow}</thead>`;
  const tfoot = footRow ? `<tfoot>${footRow}</tfoot>` : "";
  return `<div class="ce-matrix-wrap">${title}<table class="ce-matrix">${colgroup}${thead}<tbody>${bodyRows}</tbody>${tfoot}</table></div>`;
}

// ── v4 renderers ──────────────────────────────────────────────────────

function renderGrid(n: GridNode, ctx: ResolveContext): string {
  const rows = readRows(n.data_rows.bind, ctx);
  const title = n.title ? `<div class="ce-grid-title">${esc(resolveValue(n.title, ctx))}</div>` : "";

  const colgroup = `<colgroup>${n.columns.map((c) => {
    if (typeof c.width === "number") return `<col style="width:${c.width}mm">`;
    if (typeof c.width === "string" && c.width !== "auto") return `<col style="width:${c.width}">`;
    return `<col>`;
  }).join("")}</colgroup>`;

  const headerHtml = (n.header_rows ?? []).map((row) => renderHeaderRow(row, ctx)).join("");

  const bodyHtml = rows.map((row) => {
    return `<tr>${n.columns.map((c) => {
      const key = c.bind_key ?? c.id;
      const cellRaw = (row as any)[key];
      const rendered = cellRaw == null
        ? ""
        : (c.format ? formatValue(cellRaw, c.format, ctx) : String(cellRaw));
      const isNum = c.align === "right" || c.format === "number" || c.format === "currency" || c.format === "percent";
      const cls = [
        alignClass(c.align),
        c.nowrap ? "ce-nowrap" : "",
      ].filter(Boolean).join(" ");
      return `<td class="${cls}">${esc(rendered)}</td>`;
    }).join("")}</tr>`;
  }).join("");

  const footerHtml = (n.footer_rows ?? []).map((row) => renderFooterRow(row, ctx, rows, n)).join("");

  const zebra = n.zebra ?? "even";
  const gridCls = [
    "ce-grid",
    zebra !== "none" ? `ce-zebra-${zebra}` : "",
    n.border === "outer" ? "ce-border-outer" : n.border === "none" ? "ce-border-none" : "",
  ].filter(Boolean).join(" ");

  const thead = headerHtml ? `<thead>${headerHtml}</thead>` : "";
  const tfoot = footerHtml ? `<tfoot>${footerHtml}</tfoot>` : "";
  return `<div class="ce-grid-wrap">${title}<table class="${gridCls}">${colgroup}${thead}<tbody>${bodyHtml}</tbody>${tfoot}</table></div>`;
}

function renderHeaderRow(row: GridHeaderCell[], ctx: ResolveContext): string {
  return `<tr>${row.map((cell) => {
    const attrs = [
      cell.span && cell.span > 1 ? ` colspan="${cell.span}"` : "",
      cell.row_span && cell.row_span > 1 ? ` rowspan="${cell.row_span}"` : "",
    ].join("");
    const variant = cell.variant ?? "label";
    const cls = `ce-h-${variant} ${alignClass(cell.align ?? "center")}`;
    return `<th class="${cls}"${attrs}>${esc(resolveValue(cell.content, ctx))}</th>`;
  }).join("")}</tr>`;
}

function renderFooterRow(
  row: GridFooterCell[],
  ctx: ResolveContext,
  dataRows: Array<Record<string, unknown>>,
  grid: GridNode,
): string {
  return `<tr>${row.map((cell) => {
    const attrs = [
      cell.span && cell.span > 1 ? ` colspan="${cell.span}"` : "",
      cell.row_span && cell.row_span > 1 ? ` rowspan="${cell.row_span}"` : "",
    ].join("");
    const variant = cell.variant ?? "plain";
    let rendered = "";
    let numeric = false;
    if (isSumOf(cell.content)) {
      const col = grid.columns.find((c) => c.id === cell.content.column_id);
      const key = col?.bind_key ?? cell.content.column_id;
      const total = sumColumn(dataRows, key);
      const fmt = cell.content.format ?? col?.format ?? "number";
      rendered = formatValue(total, fmt, ctx);
      numeric = true;
    } else {
      rendered = resolveValue(cell.content, ctx);
    }
    const alignSrc = cell.align ?? (numeric ? "right" : "left");
    const cls = [alignClass(alignSrc), numeric ? "num" : "", `ce-h-${variant}`].filter(Boolean).join(" ");
    return `<td class="${cls}"${attrs}>${esc(rendered)}</td>`;
  }).join("")}</tr>`;
}

function isSumOf(v: any): v is { kind: "sum_of"; column_id: string; format?: any } {
  return v && typeof v === "object" && (v as any).kind === "sum_of";
}

function renderList(n: ListNode, ctx: ResolveContext): string {
  const cls = `ce-list ce-marker-${n.marker}${n.compact ? " ce-list-compact" : ""}`;
  const start = n.start && n.start !== 1 ? ` start="${n.start}"` : "";
  const useOl = n.marker !== "disc" && n.marker !== "circle" && n.marker !== "square" && n.marker !== "none";
  const tag = useOl ? "ol" : "ul";
  const items = n.items.map((it) => renderListItem(it, ctx)).join("");
  return `<${tag} class="${cls}"${useOl ? start : ""}>${items}</${tag}>`;
}

function renderListItem(item: ListItem, ctx: ResolveContext): string {
  let inner = "";
  if (item.runs && item.runs.length) {
    inner = item.runs.map((r) => {
      const c = r.emphasis ? ` class="ce-em-${r.emphasis}"` : "";
      return `<span${c}>${esc(resolveValue(r.text, ctx))}</span>`;
    }).join("");
  } else if (item.text) {
    inner = esc(resolveValue(item.text, ctx));
  }
  const child = item.children ? renderList(item.children, ctx) : "";
  return `<li>${inner}${child}</li>`;
}

function renderLabelFill(n: LabelFillNode, ctx: ResolveContext): string {
  const rule = n.rule ?? "dotted";
  const width = n.value_width == null
    ? ""
    : typeof n.value_width === "number"
      ? `min-width:${n.value_width}mm`
      : `min-width:${n.value_width}`;
  const emphCls = n.emphasis === "primary" ? " ce-primary" : "";
  const labelCls = `ce-fill-label${n.label_bold ? " ce-bold" : ""}`;
  return `<span class="ce-fill ce-fill-rule-${rule}${emphCls}"><span class="${labelCls}">${esc(resolveValue(n.label, ctx))}</span><span class="ce-fill-value" style="${width}">${esc(resolveValue(n.value, ctx))}</span></span>`;
}

function renderFieldRow(n: FieldRowNode, ctx: ResolveContext): string {
  const gap = n.gap_mm ?? 8;
  const cols = n.columns && n.columns.length
    ? n.columns.map((c) => (typeof c === "number" ? `${c}mm` : c)).join(" ")
    : `repeat(${n.fields.length}, 1fr)`;
  const items = n.fields.map((f) => `<div>${renderLabelFill(f, ctx)}</div>`).join("");
  return `<div class="ce-field-row" style="grid-template-columns:${cols};gap:${gap}mm">${items}</div>`;
}

function renderColumns(n: ColumnsNode, ctx: ResolveContext): string {
  const gap = n.gap_mm ?? 6;
  const count = Math.max(1, n.count | 0);
  const style = `grid-template-columns: repeat(${count}, 1fr); gap: ${gap}mm`;
  if (n.column_children && n.column_children.length) {
    const cols = n.column_children.slice(0, count).map((children) =>
      `<div class="ce-columns-col">${children.map((c) => renderNode(c, ctx)).join("\n")}</div>`
    ).join("");
    return `<div class="ce-columns" style="${style}">${cols}</div>`;
  }
  const flat = (n.children ?? []).map((c) => renderNode(c, ctx)).join("\n");
  return `<div class="ce-columns" style="${style}"><div>${flat}</div></div>`;
}

function renderLegal(n: LegalNoticeNode, ctx: ResolveContext) {
  const cls = `ce-legal${n.border === false ? "" : " bordered"}`;
  const title = n.title ? `<div class="ce-legal-title">${esc(resolveValue(n.title, ctx))}</div>` : "";
  const paras = n.paragraphs.map((p) => `<p class="ce-para">${esc(resolveValue(p, ctx))}</p>`).join("");
  return `<div class="${cls}">${title}${paras}</div>`;
}

function renderSignature(n: SignatureStripNode, ctx: ResolveContext) {
  const cols = n.slots.length || 1;
  const slots = n.slots.map((s) => {
    const sub = s.sub_caption ? `<div class="ce-signature-sub">${esc(resolveValue(s.sub_caption, ctx))}</div>` : "";
    return `<div class="ce-signature-slot">${esc(resolveValue(s.caption, ctx))}${sub}</div>`;
  }).join("");
  return `<div class="ce-signature" style="grid-template-columns: repeat(${cols}, 1fr);">${slots}</div>`;
}

function renderImage(n: ImageNode): string {
  const w = n.width_mm ? ` width="${mmToPx(n.width_mm)}"` : "";
  const h = n.height_mm ? ` height="${mmToPx(n.height_mm)}"` : "";
  const cls = `ce-image ${n.align === "center" ? "center" : n.align === "right" ? "right" : ""}`.trim();
  return `<img class="${cls}" src="${esc(n.data_url)}" alt=""${w}${h}>`;
}

// ── Utilities ─────────────────────────────────────────────────────────

function alignClass(a?: "left" | "right" | "center"): string {
  return a === "right" ? "num" : a === "center" ? "ctr" : "lft";
}

function mmToPx(mm: number): number {
  return Math.round((mm / 25.4) * 96);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
