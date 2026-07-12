// @ts-nocheck — Deno runtime
/**
 * Certificate Engine v3 — AST → PDF producer (Deno-native, colocated).
 *
 * Renders the v3 AST directly through pdf-lib. This is the Phase-B
 * runtime decision documented in .lovable/plan.md: no browser, no
 * external service, no HTML rasteriser. The AST is already semantic
 * (heading / key_value / matrix / …), so the intermediate HTML that
 * `compile()` produces is bypassed for actual PDF output. `compile()`
 * remains available for the publisher workbench live preview which
 * runs inside a real browser.
 *
 * Supported nodes: heading, rich_text, key_value, identity_strip,
 * section, matrix (paginated body + repeat header + footer),
 * legal_notice, signature_strip, spacer. `image` is a no-op for now.
 *
 * Deterministic: no timestamps, no random ids.
 */
import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  rgb,
} from "https://esm.sh/pdf-lib@1.17.1";
import type {
  CertificatePayload,
  CertificateTemplateV3,
  HeadingNode,
  IdentityStripNode,
  KeyValueNode,
  LegalNoticeNode,
  MatrixNode,
  Node,
  RichTextNode,
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

const MM_TO_PT = 72 / 25.4;
const PAPER_MM: Record<string, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  Letter: { w: 215.9, h: 279.4 },
  Legal: { w: 215.9, h: 355.6 },
};

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
}

interface RenderState {
  doc: PDFDocument;
  page: PDFPage;
  pageW: number;
  pageH: number;
  ml: number;
  mr: number;
  mt: number;
  mb: number;
  headerH: number;
  footerH: number;
  cursorY: number;
  fonts: Fonts;
  template: CertificateTemplateV3;
  ctx: ResolveContext;
}

export interface AstRenderOptions {
  currency?: string;
  locale?: string;
}

export async function renderCertificateAstToPdf(
  template: CertificateTemplateV3,
  payload: CertificatePayload,
  opts: AstRenderOptions = {},
): Promise<{ bytes: Uint8Array; unresolved: string[] }> {
  const doc = await PDFDocument.create();
  doc.setTitle(template.display_name);
  doc.setProducer("certificate-engine v3");
  doc.setCreator("certificate-engine v3");
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  const paper = PAPER_MM[template.paper_format.size] ?? PAPER_MM.A4;
  const isLandscape = template.paper_format.orientation === "landscape";
  const pageW = (isLandscape ? paper.h : paper.w) * MM_TO_PT;
  const pageH = (isLandscape ? paper.w : paper.h) * MM_TO_PT;
  const ml = template.paper_format.margin_left * MM_TO_PT;
  const mr = template.paper_format.margin_right * MM_TO_PT;
  const mt = template.paper_format.margin_top * MM_TO_PT;
  const mb = template.paper_format.margin_bottom * MM_TO_PT;
  const headerH = (template.paper_format.header_height ?? 0) * MM_TO_PT;
  const footerH = (template.paper_format.footer_height ?? 0) * MM_TO_PT;

  const ctx = createContext(payload, opts);
  const state: RenderState = {
    doc,
    page: doc.addPage([pageW, pageH]),
    pageW, pageH, ml, mr, mt, mb, headerH, footerH,
    cursorY: pageH - mt - headerH,
    fonts, template, ctx,
  };
  drawPageChrome(state);

  for (const node of template.document) renderNode(node, state);

  const bytes = await doc.save({ updateFieldAppearances: false });
  return { bytes, unresolved: [...ctx.unresolved].sort() };
}

// ── Page chrome ───────────────────────────────────────────────────────

function drawPageChrome(s: RenderState) {
  const { template } = s;
  if (template.page_master?.header?.length && s.headerH > 0) {
    const savedY = s.cursorY;
    s.cursorY = s.pageH - s.mt;
    for (const n of template.page_master.header) renderNode(n, s);
    s.cursorY = savedY;
  }
  if (template.page_master?.footer?.length && s.footerH > 0) {
    const savedY = s.cursorY;
    s.cursorY = s.mb + s.footerH;
    for (const n of template.page_master.footer) renderNode(n, s);
    s.cursorY = savedY;
  }
}

function ensureSpace(s: RenderState, needed: number) {
  const minY = s.mb + s.footerH;
  if (s.cursorY - needed < minY) newPage(s);
}

function newPage(s: RenderState) {
  s.page = s.doc.addPage([s.pageW, s.pageH]);
  s.cursorY = s.pageH - s.mt - s.headerH;
  drawPageChrome(s);
}

function contentWidth(s: RenderState): number {
  return s.pageW - s.ml - s.mr;
}

// ── Node dispatch ─────────────────────────────────────────────────────

function renderNode(node: Node, s: RenderState) {
  switch (node.type) {
    case "heading":         return renderHeading(node, s);
    case "rich_text":       return renderRichText(node, s);
    case "key_value":       return renderKeyValue(node, s);
    case "identity_strip":  return renderIdentityStrip(node, s);
    case "section":         return renderSection(node, s);
    case "matrix":          return renderMatrix(node, s);
    case "legal_notice":    return renderLegal(node, s);
    case "signature_strip": return renderSignature(node, s);
    case "spacer":          return advance(s, node.size_mm * MM_TO_PT);
    case "image":           return; // no-op in AST producer
  }
}

function advance(s: RenderState, dy: number) {
  ensureSpace(s, dy);
  s.cursorY -= dy;
}

// ── Text primitives ───────────────────────────────────────────────────

function drawText(s: RenderState, text: string, x: number, y: number, size: number, font: PDFFont, color = rgb(0.07, 0.07, 0.07)) {
  s.page.drawText(text, { x, y: y - size, size, font, color });
}

function wrapText(font: PDFFont, size: number, text: string, maxWidth: number): string[] {
  const words = String(text).split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(trial, size) <= maxWidth) cur = trial;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function drawWrapped(s: RenderState, text: string, x: number, size: number, font: PDFFont, maxWidth: number, lineGap = 1.35, color = rgb(0.07, 0.07, 0.07)) {
  const lines = wrapText(font, size, text, maxWidth);
  const lineH = size * lineGap;
  ensureSpace(s, lineH * lines.length);
  for (const ln of lines) {
    drawText(s, ln, x, s.cursorY, size, font, color);
    s.cursorY -= lineH;
  }
}

// ── Nodes ─────────────────────────────────────────────────────────────

function renderHeading(n: HeadingNode, s: RenderState) {
  const size = n.level === 1 ? 14 : n.level === 2 ? 11 : 10;
  const font = s.fonts.bold;
  const text = resolveValue(n.text, s.ctx);
  const maxW = contentWidth(s);
  const lines = wrapText(font, size, text, maxW);
  const lineH = size * 1.25;
  ensureSpace(s, lineH * lines.length + 4);
  for (const ln of lines) {
    const w = font.widthOfTextAtSize(ln, size);
    const x = n.align === "center" ? s.ml + (maxW - w) / 2
      : n.align === "right" ? s.pageW - s.mr - w
      : s.ml;
    drawText(s, ln, x, s.cursorY, size, font);
    s.cursorY -= lineH;
  }
  s.cursorY -= 4;
}

function renderRichText(n: RichTextNode, s: RenderState) {
  const size = 9;
  const maxW = contentWidth(s);
  for (const runs of n.paragraphs) {
    const text = runs.map((r) => resolveValue(r.text, s.ctx)).join("");
    const anyBold = runs.some((r) => r.emphasis === "bold");
    const anyItalic = runs.some((r) => r.emphasis === "italic");
    const font = anyBold ? s.fonts.bold : anyItalic ? s.fonts.italic : s.fonts.regular;
    const color = runs.some((r) => r.emphasis === "muted") ? rgb(0.33, 0.33, 0.33) : rgb(0.07, 0.07, 0.07);
    drawWrapped(s, text, s.ml, size, font, maxW, 1.35, color);
    s.cursorY -= 2;
  }
}

function renderKeyValue(n: KeyValueNode, s: RenderState) {
  const size = 9;
  const totalW = contentWidth(s);
  const labelW = Math.min(totalW * 0.4, 40 * MM_TO_PT);
  const label = resolveValue(n.label, s.ctx);
  const value = resolveValue(n.value, s.ctx);
  const valueFont = n.emphasis === "primary" ? s.fonts.bold : s.fonts.regular;
  const lineH = size * 1.35;
  const valueLines = wrapText(valueFont, size, value, totalW - labelW - 6);
  const rowH = Math.max(lineH, lineH * valueLines.length);
  ensureSpace(s, rowH);
  drawText(s, label, s.ml, s.cursorY, size, s.fonts.regular, rgb(0.33, 0.33, 0.33));
  let vy = s.cursorY;
  for (const vl of valueLines) {
    drawText(s, vl, s.ml + labelW, vy, size, valueFont);
    vy -= lineH;
  }
  s.cursorY -= rowH;
}

function renderIdentityStrip(n: IdentityStripNode, s: RenderState) {
  const totalW = contentWidth(s);
  const gap = 6 * MM_TO_PT;
  const colW = (totalW - gap) / 2;
  const size = 9;
  const lineH = size * 1.35;
  const startY = s.cursorY;

  const drawCol = (title: any, items: KeyValueNode[], xOff: number): number => {
    let y = startY;
    if (title) {
      const t = resolveValue(title, s.ctx);
      s.page.drawText(t, { x: s.ml + xOff, y: y - size, size, font: s.fonts.bold });
      y -= lineH;
      s.page.drawLine({
        start: { x: s.ml + xOff, y: y + 1 },
        end: { x: s.ml + xOff + colW, y: y + 1 },
        thickness: 0.4, color: rgb(0.2, 0.2, 0.2),
      });
      y -= 2;
    }
    for (const kv of items) {
      const labelW = Math.min(colW * 0.45, 40 * MM_TO_PT);
      const label = resolveValue(kv.label, s.ctx);
      const value = resolveValue(kv.value, s.ctx);
      const valueFont = kv.emphasis === "primary" ? s.fonts.bold : s.fonts.regular;
      const valueLines = wrapText(valueFont, size, value, colW - labelW - 4);
      const rowH = lineH * valueLines.length;
      s.page.drawText(label, { x: s.ml + xOff, y: y - size, size, font: s.fonts.regular, color: rgb(0.33, 0.33, 0.33) });
      let vy = y;
      for (const vl of valueLines) {
        s.page.drawText(vl, { x: s.ml + xOff + labelW, y: vy - size, size, font: valueFont });
        vy -= lineH;
      }
      y -= rowH;
    }
    return startY - y;
  };

  const leftH = drawCol(n.left_title, n.left, 0);
  const rightH = drawCol(n.right_title, n.right, colW + gap);
  const used = Math.max(leftH, rightH);
  ensureSpace(s, used);
  s.cursorY = startY - used - 4;
}

function renderSection(n: SectionNode, s: RenderState) {
  if (n.title) {
    const t = resolveValue(n.title, s.ctx);
    const size = 10;
    ensureSpace(s, size * 1.5);
    drawText(s, t, s.ml, s.cursorY, size, s.fonts.bold);
    s.cursorY -= size * 1.15;
    s.page.drawLine({
      start: { x: s.ml, y: s.cursorY + 1 },
      end: { x: s.pageW - s.mr, y: s.cursorY + 1 },
      thickness: 0.4, color: rgb(0.2, 0.2, 0.2),
    });
    s.cursorY -= 4;
  }
  for (const c of n.children) renderNode(c, s);
  s.cursorY -= 4;
}

function renderMatrix(n: MatrixNode, s: RenderState) {
  const rows = readRows(n.rows_binding, s.ctx);
  const totalW = contentWidth(s);
  const size = 8.5;
  const cellPad = 3;
  const rowH = size * 1.35 + cellPad * 2;

  const fixed: number[] = n.columns.map((c) => typeof c.width === "number" ? c.width * MM_TO_PT : 0);
  const flexCount = fixed.filter((w) => w === 0).length;
  const remaining = totalW - fixed.reduce((a, b) => a + b, 0);
  const flexWidth = flexCount > 0 ? Math.max(20, remaining / flexCount) : 0;
  const colW = fixed.map((w) => (w > 0 ? w : flexWidth));

  if (n.title) {
    const t = resolveValue(n.title, s.ctx);
    ensureSpace(s, 12);
    drawText(s, t, s.ml, s.cursorY, 10, s.fonts.bold);
    s.cursorY -= 12;
  }

  const drawHeader = () => {
    ensureSpace(s, rowH);
    s.page.drawRectangle({
      x: s.ml, y: s.cursorY - rowH, width: totalW, height: rowH,
      color: rgb(0.93, 0.93, 0.93),
    });
    let x = s.ml;
    for (let i = 0; i < n.columns.length; i++) {
      const c = n.columns[i];
      const w = colW[i];
      drawCell(s, resolveValue(c.header, s.ctx), x, s.cursorY, w, rowH, c.align ?? "center", s.fonts.bold, size, cellPad);
      x += w;
    }
    s.cursorY -= rowH;
  };

  drawHeader();

  for (const row of rows) {
    if (s.cursorY - rowH < s.mb + s.footerH) {
      newPage(s);
      if (n.repeat_header !== false) drawHeader();
    }
    let x = s.ml;
    for (let i = 0; i < n.columns.length; i++) {
      const c = n.columns[i];
      const w = colW[i];
      const raw = (row as any)[c.key];
      const rendered = raw == null ? "" : (c.format ? formatValue(raw, c.format, s.ctx) : String(raw));
      drawCell(s, rendered, x, s.cursorY, w, rowH, c.align, s.fonts.regular, size, cellPad);
      x += w;
    }
    s.cursorY -= rowH;
  }

  if (n.footer) {
    ensureSpace(s, rowH);
    s.page.drawRectangle({
      x: s.ml, y: s.cursorY - rowH, width: totalW, height: rowH,
      color: rgb(0.96, 0.96, 0.96),
    });
    let x = s.ml;
    for (let i = 0; i < n.columns.length; i++) {
      const c = n.columns[i];
      const w = colW[i];
      let content = "";
      let align = c.align;
      if (n.footer.sum_columns.includes(c.key)) {
        content = formatValue(sumColumn(rows, c.key), c.format ?? "number", s.ctx);
        align = c.align ?? "right";
      } else if (i === 0) {
        content = resolveValue(n.footer.label, s.ctx);
        align = c.align ?? "left";
      }
      drawCell(s, content, x, s.cursorY, w, rowH, align, s.fonts.bold, size, cellPad);
      x += w;
    }
    s.cursorY -= rowH;
  }

  s.cursorY -= 4;
}

function drawCell(s: RenderState, text: string, x: number, yTop: number, w: number, h: number,
  align: "left" | "right" | "center" | undefined, font: PDFFont, size: number, pad: number) {
  s.page.drawRectangle({
    x, y: yTop - h, width: w, height: h,
    borderColor: rgb(0.4, 0.4, 0.4), borderWidth: 0.4,
  });
  let display = text;
  if (font.widthOfTextAtSize(display, size) > w - pad * 2) {
    while (display.length > 1 && font.widthOfTextAtSize(display + "…", size) > w - pad * 2) {
      display = display.slice(0, -1);
    }
    display = display + "…";
  }
  const tw = font.widthOfTextAtSize(display, size);
  const tx = align === "right" ? x + w - pad - tw
    : align === "center" ? x + (w - tw) / 2
    : x + pad;
  const ty = yTop - h + (h - size) / 2 + size * 0.15;
  s.page.drawText(display, { x: tx, y: ty, size, font });
}

function renderLegal(n: LegalNoticeNode, s: RenderState) {
  const size = 9;
  const pad = 5;
  const maxW = contentWidth(s) - pad * 2;
  let usedH = pad;
  if (n.title) {
    const t = resolveValue(n.title, s.ctx);
    usedH += wrapText(s.fonts.bold, size, t, maxW).length * size * 1.3 + 2;
  }
  for (const p of n.paragraphs) {
    const txt = resolveValue(p, s.ctx);
    usedH += wrapText(s.fonts.regular, size, txt, maxW).length * size * 1.35 + 2;
  }
  usedH += pad;

  ensureSpace(s, usedH);
  const boxTop = s.cursorY;
  if (n.border !== false) {
    s.page.drawRectangle({
      x: s.ml, y: boxTop - usedH, width: contentWidth(s), height: usedH,
      borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 0.5,
    });
  }
  s.cursorY -= pad;
  if (n.title) {
    drawWrapped(s, resolveValue(n.title, s.ctx), s.ml + pad, size, s.fonts.bold, maxW);
    s.cursorY -= 2;
  }
  for (const p of n.paragraphs) {
    drawWrapped(s, resolveValue(p, s.ctx), s.ml + pad, size, s.fonts.regular, maxW);
    s.cursorY -= 2;
  }
  s.cursorY = boxTop - usedH - 4;
}

function renderSignature(n: SignatureStripNode, s: RenderState) {
  const totalW = contentWidth(s);
  const gap = 8 * MM_TO_PT;
  const cols = n.slots.length || 1;
  const colW = (totalW - gap * (cols - 1)) / cols;
  const size = 8.5;
  const lineH = size * 1.35;
  const slotH = 20 + lineH * 2 + 6;

  ensureSpace(s, slotH + 14);
  s.cursorY -= 14;
  const topY = s.cursorY;
  for (let i = 0; i < n.slots.length; i++) {
    const slot = n.slots[i];
    const x = s.ml + i * (colW + gap);
    const lineY = topY - 20;
    s.page.drawLine({
      start: { x, y: lineY }, end: { x: x + colW, y: lineY },
      thickness: 0.5, color: rgb(0.07, 0.07, 0.07),
    });
    s.page.drawText(resolveValue(slot.caption, s.ctx), {
      x, y: lineY - size - 3, size, font: s.fonts.regular,
    });
    if (slot.sub_caption) {
      s.page.drawText(resolveValue(slot.sub_caption, s.ctx), {
        x, y: lineY - size - 3 - lineH, size, font: s.fonts.regular,
        color: rgb(0.33, 0.33, 0.33),
      });
    }
  }
  s.cursorY = topY - slotH;
}
