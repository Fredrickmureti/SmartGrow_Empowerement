// @ts-nocheck — Deno runtime
/**
 * Certificate Engine v3 — AST → HTML + CSS Paged Media compiler.
 *
 * Deterministic: same (template, payload) always produces byte-identical
 * output. No timestamps, no random ids. Emits a single self-contained
 * HTML document with an inline stylesheet using CSS Paged Media rules
 * (@page, page-break-*, running headers/footers). The PDF producer
 * (Phase B decision) rasterises this HTML.
 */
import type {
  CertificatePayload,
  CertificateTemplateV3,
  IdentityStripNode,
  ImageNode,
  KeyValueNode,
  LegalNoticeNode,
  MatrixNode,
  Node,
  PageMaster,
  PaperFormat,
  SectionNode,
  SignatureStripNode,
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
  /** Payload paths that were bound but resolved to null/undefined. */
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
  const css = buildCss(template.paper_format);
  const body = template.document.map((n) => renderNode(n, ctx)).join("\n");
  const header = template.page_master?.header
    ? `<div class="page-header">${template.page_master.header.map((n) => renderNode(n, ctx)).join("\n")}</div>`
    : "";
  const footer = template.page_master?.footer
    ? `<div class="page-footer">${template.page_master.footer.map((n) => renderNode(n, ctx)).join("\n")}</div>`
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

// ── CSS ───────────────────────────────────────────────────────────────

function buildCss(pf: PaperFormat): string {
  const size = `${pf.size} ${pf.orientation}`;
  return `
@page {
  size: ${size};
  margin: ${pf.margin_top}mm ${pf.margin_right}mm ${pf.margin_bottom}mm ${pf.margin_left}mm;
  @top-center { content: element(pageHeader); }
  @bottom-center { content: element(pageFooter); }
}
html, body { margin: 0; padding: 0; }
body {
  font-family: "Helvetica", "Arial", sans-serif;
  font-size: 9pt;
  color: #111;
  line-height: 1.35;
}
.page-header { position: running(pageHeader); height: ${pf.header_height}mm; }
.page-footer { position: running(pageFooter); height: ${pf.footer_height}mm; font-size: 8pt; color: #444; }
.document { }
h1.ce-h { font-size: 14pt; margin: 0 0 6pt 0; font-weight: 700; }
h2.ce-h { font-size: 11pt; margin: 10pt 0 4pt 0; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
h3.ce-h { font-size: 10pt; margin: 8pt 0 3pt 0; font-weight: 700; }
.ce-align-left   { text-align: left; }
.ce-align-center { text-align: center; }
.ce-align-right  { text-align: right; }
.ce-section { margin-bottom: 8pt; }
.ce-section-title { font-size: 10pt; font-weight: 700; margin: 6pt 0 3pt 0; border-bottom: 0.5pt solid #333; padding-bottom: 1pt; }
.ce-keep-together { page-break-inside: avoid; break-inside: avoid; }
.ce-kv { display: flex; gap: 6pt; margin: 1pt 0; }
.ce-kv-label { color: #555; min-width: 40mm; }
.ce-kv-value { color: #111; font-weight: 500; }
.ce-kv-primary .ce-kv-value { font-weight: 700; }
.ce-identity { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; margin: 4pt 0 8pt 0; }
.ce-identity-col-title { font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; margin-bottom: 2pt; border-bottom: 0.5pt solid #333; padding-bottom: 1pt; }
.ce-para { margin: 3pt 0; }
.ce-em-bold { font-weight: 700; }
.ce-em-italic { font-style: italic; }
.ce-em-muted { color: #555; }
.ce-matrix-wrap { margin: 4pt 0 8pt 0; }
.ce-matrix-title { font-size: 10pt; font-weight: 700; margin-bottom: 2pt; }
.ce-matrix { width: 100%; border-collapse: collapse; table-layout: auto; }
.ce-matrix thead { display: table-header-group; }
.ce-matrix tfoot { display: table-footer-group; }
.ce-matrix th, .ce-matrix td { border: 0.4pt solid #666; padding: 2.5pt 4pt; font-size: 8.5pt; vertical-align: middle; }
.ce-matrix thead th { background: #eee; font-weight: 700; }
.ce-matrix tfoot td { background: #f4f4f4; font-weight: 700; }
.ce-matrix .num { text-align: right; font-variant-numeric: tabular-nums; }
.ce-matrix .ctr { text-align: center; }
.ce-legal { margin: 8pt 0; padding: 5pt 6pt; }
.ce-legal.bordered { border: 0.5pt solid #333; }
.ce-legal-title { font-weight: 700; margin-bottom: 3pt; text-transform: uppercase; letter-spacing: 0.02em; }
.ce-signature { display: grid; gap: 8mm; margin-top: 14pt; page-break-inside: avoid; }
.ce-signature-slot { border-top: 0.5pt solid #111; padding-top: 3pt; font-size: 8.5pt; }
.ce-signature-sub { color: #555; }
.ce-image { display: block; }
.ce-image.center { margin: 0 auto; }
.ce-image.right  { margin-left: auto; }
`.trim();
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
    default: {
      const _exhaustive: never = node;
      return "";
    }
  }
}

function renderHeading(n: Extract<Node, {type:"heading"}>, ctx: ResolveContext) {
  const tag = `h${n.level}`;
  return `<${tag} class="ce-h ce-align-${n.align ?? "left"}">${esc(resolveValue(n.text, ctx))}</${tag}>`;
}

function renderRichText(n: Extract<Node, {type:"rich_text"}>, ctx: ResolveContext) {
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
  const col = (title: any, items: KeyValueNode[]) => {
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
    ? `<tr>${n.column_groups.map((g) => `<th colspan="${g.span}" class="ctr">${esc(resolveValue(g.label, ctx))}</th>`).join("")}</tr>`
    : "";

  const headRow = `<tr>${n.columns.map((c) => {
    const align = c.align ? ` class="${alignClass(c.align)}"` : "";
    return `<th${align}>${esc(resolveValue(c.header, ctx))}</th>`;
  }).join("")}</tr>`;

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

  const thead = `<thead>${groupRow}${headRow}</thead>`;
  const tfoot = footRow ? `<tfoot>${footRow}</tfoot>` : "";
  return `<div class="ce-matrix-wrap">${title}<table class="ce-matrix">${colgroup}${thead}<tbody>${bodyRows}</tbody>${tfoot}</table></div>`;
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
  return a === "right" ? "num" : a === "center" ? "ctr" : "";
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
