/* Browser mirror of supabase/functions/_shared/pdf/certificateRendererV2.ts. Auto-mirrored — keep in sync. */
/**
 * certificateRendererV2 — country-agnostic block-primitive certificate
 * renderer.
 *
 * Design goals (ADR-0060 refinement — see docs/adr/0060-*):
 *
 *   1. The renderer knows nothing about P9, IRP5, W-2, or any other
 *      country-specific document. It understands only reusable layout
 *      primitives (Heading, Paragraph, FieldGrid, Table, Notes,
 *      Divider, Spacer, Image, SignatureBlock).
 *
 *   2. Localization packs supply a `body.blocks[]` document AST. Every
 *      user-visible string (section titles, column headers, totals
 *      labels, legal wording, signature captions) is pack-authored and
 *      versioned with the pack — never hardcoded in this file.
 *
 *   3. The table primitive is a real layout engine: intrinsic column
 *      measurement, fixed / fraction / auto width distribution, per-cell
 *      wrapping with configurable padding, repeated header row after
 *      page break, and first-class footer (totals) rows.
 *
 * Templates opt into v2 by setting `body.schema_version = 2` on the
 * certificate_template row. Callers dispatch through
 * `renderCertificatePdf` in ./certificateRenderer.ts which branches on
 * that flag; v1 templates continue to render unchanged.
 *
 * Paper size and orientation are still template-owned metadata
 * (`body.page = { size, orientation }`), parallel to Odoo's per-report
 * `paperformat_id`.
 */
import {
  PDFDocument,
  PDFPage,
  PDFFont,
  StandardFonts,
  rgb,
} from "pdf-lib";
import { winansiSafe } from "./winansi";
import type { OrganizationBranding } from "./_types";
import type { MonthlyRow } from "./_types";

// ── Block AST ─────────────────────────────────────────────────────────

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | FieldGridBlock
  | TableBlock
  | NotesBlock
  | DividerBlock
  | SpacerBlock
  | ImageBlock
  | SignatureBlock;

export interface HeadingBlock {
  type: "heading";
  text: string;              // pack-authored, i18n-ready
  level?: 1 | 2 | 3;         // default 2
  align?: "left" | "center" | "right";
}

export interface ParagraphBlock {
  type: "paragraph";
  text: string;
  align?: "left" | "center" | "right";
  emphasis?: "regular" | "italic" | "bold" | "muted";
}

export interface FieldGridBlock {
  type: "field_grid";
  title?: string;
  columns?: 1 | 2 | 3 | 4;   // default 2
  data_source?: string;      // "employer" | "employee" | payload key
  fields: Array<{
    key: string;             // dotted path into the resolved data source
    label: string;           // pack-authored label
    format?: ValueFormat;
    emphasis?: "primary" | "regular";
  }>;
}

export interface TableColumn {
  key: string;
  header: string;
  width?: "auto" | number | string; // number = pt, "1fr" / "2fr", "auto"
  align?: "left" | "right" | "center";
  format?: ValueFormat;
  header_align?: "left" | "right" | "center";
}

export interface TableBlock {
  type: "table";
  title?: string;
  data_source: string;       // resolver name (see resolveDataSource)
  columns: TableColumn[];
  group_by?: string;         // e.g. "month_index"
  filter?: { key: string; in: string[] }; // e.g. rule_code ∈ set
  aggregate?: "sum";         // aggregation for group_by cells
  footer?: {
    label: string;
    aggregate?: "sum";       // per-column sum
    include_columns?: string[]; // which columns get a footer value
  };
  options?: {
    striped?: boolean;
    padding?: number;        // pt, default 4
    wrap?: boolean;          // default true
    repeat_header?: boolean; // default true
    line_height?: number;    // default 1.25
    header_bg?: boolean;     // default true
  };
}

export interface NotesBlock {
  type: "notes";
  title?: string;            // e.g. "IMPORTANT"
  paragraphs: string[];      // one paragraph per array entry
  emphasis?: "regular" | "italic";
  border?: boolean;          // default true
}

export interface DividerBlock { type: "divider"; }
export interface SpacerBlock { type: "spacer"; size?: number; }

export interface ImageBlock {
  type: "image";
  data: string;              // base64 (data URL or bare)
  width?: number;
  height?: number;
  align?: "left" | "center" | "right";
}

export interface SignatureBlock {
  type: "signature_block";
  title?: string;
  slots: Array<{ caption: string; sub_caption?: string }>;
}

export type ValueFormat =
  | "currency" | "number" | "percent" | "date" | "text";

// ── Public entry ──────────────────────────────────────────────────────

export interface CertificateTemplateV2 {
  code: string;
  display_name: string;
  legal_reference?: string | null;
  regulation_citation?: string | null;
  effective_date?: string | null;
  authority_name?: string | null;
  body: {
    schema_version?: number;
    page?: { size?: "a4"; orientation?: "portrait" | "landscape" };
    blocks?: Block[];
    data_source?: string;
    footer_note?: string | null;
  } | null;
}

export interface CertificatePayload {
  employee: Record<string, unknown>;
  employer: Record<string, unknown>;
  fiscal_year: number;
  period_label?: string;
  currency?: string;
  monthly: MonthlyRow[];
  ytdRows: Array<{
    rule_code: string;
    category?: string | null;
    employee_amount: number;
    employer_amount: number;
    taxable_amount: number;
  }>;
  totals: { employee: number; employer: number; taxable: number };
  serial_number?: string;
  generated_at?: string;
}

export interface RenderOptions {
  branding?: OrganizationBranding | null;
}

// ── Layout constants ──────────────────────────────────────────────────

const MM = 72 / 25.4;

export function computeLayoutV2(template: CertificateTemplateV2) {
  const page = template.body?.page ?? {};
  const landscape = String(page.orientation ?? "portrait").toLowerCase() === "landscape";
  const PAGE_W = (landscape ? 297 : 210) * MM;
  const PAGE_H = (landscape ? 210 : 297) * MM;
  const MARGIN = 42;
  return { PAGE_W, PAGE_H, MARGIN, CONTENT_W: PAGE_W - MARGIN * 2 };
}

const COL = {
  text: rgb(0.08, 0.08, 0.12),
  muted: rgb(0.42, 0.42, 0.48),
  rule: rgb(0.72, 0.72, 0.78),
  ruleStrong: rgb(0.35, 0.35, 0.4),
  bandBg: rgb(0.965, 0.965, 0.975),
  stripe: rgb(0.98, 0.98, 0.99),
} as const;

const FONT_SIZE = {
  h1: 16, h2: 11.5, h3: 9.5,
  body: 9.5,
  fieldLabel: 7.25,
  fieldValue: 9.5,
  fieldValuePrimary: 11,
  tableHeader: 8,
  tableCell: 8.5,
  footer: 7,
  notesTitle: 8.5,
  notes: 8.25,
} as const;

// ── Draw context ──────────────────────────────────────────────────────

interface Ctx {
  doc: PDFDocument;
  fontRegular: PDFFont;
  fontBold: PDFFont;
  fontItalic: PDFFont;
  page: PDFPage;
  y: number;
  pageNum: number;
  template: CertificateTemplateV2;
  payload: CertificatePayload;
  branding: OrganizationBranding | null;
  employer: Record<string, unknown>;
  PAGE_W: number; PAGE_H: number; MARGIN: number; CONTENT_W: number;
}

function newPage(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([ctx.PAGE_W, ctx.PAGE_H]);
  ctx.pageNum += 1;
  ctx.y = ctx.PAGE_H - ctx.MARGIN;
}

function ensureSpace(ctx: Ctx, needed: number) {
  if (ctx.y - needed < ctx.MARGIN + 30) newPage(ctx);
}

const s = (v: unknown) => winansiSafe(v ?? "");

// ── Value formatting ─────────────────────────────────────────────────

export function formatValue(v: unknown, format: ValueFormat | undefined, currency: string): string {
  if (v === null || v === undefined || v === "") return "";
  switch (format) {
    case "currency":
    case "number": {
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      const abs = Math.abs(n).toLocaleString("en-US", {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      });
      const neg = n < 0 ? `(${abs})` : abs;
      return format === "currency" && currency ? `${currency} ${neg}` : neg;
    }
    case "percent": {
      const n = Number(v);
      return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : String(v);
    }
    case "date": {
      const d = new Date(String(v));
      return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
    }
    default:
      return String(v);
  }
}

// ── Text wrapping ─────────────────────────────────────────────────────

export function wrapToWidth(
  text: string, font: PDFFont, size: number, maxW: number,
): string[] {
  if (!text) return [""];
  const out: string[] = [];
  for (const paragraph of String(text).split(/\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(""); continue; }
    let line = "";
    for (const w of words) {
      const trial = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(trial, size) <= maxW) {
        line = trial;
      } else {
        if (line) out.push(line);
        // If a single word overflows, hard-break it.
        if (font.widthOfTextAtSize(w, size) > maxW) {
          let buf = "";
          for (const ch of w) {
            if (font.widthOfTextAtSize(buf + ch, size) > maxW) {
              out.push(buf); buf = ch;
            } else {
              buf += ch;
            }
          }
          line = buf;
        } else {
          line = w;
        }
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

// ── Data-source resolver ─────────────────────────────────────────────

function pathGet(obj: any, path: string): unknown {
  return path.split(".").reduce((a, k) => (a == null ? a : a[k]), obj);
}

function resolveDataSource(ctx: Ctx, name: string): any[] {
  switch (name) {
    case "monthly_breakdown": return ctx.payload.monthly ?? [];
    case "ytd_rows": return ctx.payload.ytdRows ?? [];
    case "employee": return [ctx.payload.employee];
    case "employer": return [ctx.employer];
    default: return (ctx.payload as any)[name] ?? [];
  }
}

function resolveFieldContext(ctx: Ctx, name: string): any {
  switch (name) {
    case "employer": return ctx.employer;
    case "employee": return ctx.payload.employee;
    case "totals": return ctx.payload.totals;
    default: return (ctx.payload as any)[name] ?? {};
  }
}

// ── Renderer ──────────────────────────────────────────────────────────

export async function renderCertificatePdfV2(
  template: CertificateTemplateV2,
  payload: CertificatePayload,
  opts: RenderOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const employer = {
    name: opts.branding?.name ?? payload.employer?.name ?? "",
    tax_pin: (opts.branding as any)?.tax_pin ?? (payload.employer as any)?.tax_pin ?? "",
    address: (opts.branding as any)?.address ?? (payload.employer as any)?.address ?? "",
    tax_office: (opts.branding as any)?.tax_office ?? (payload.employer as any)?.tax_office ?? "",
    phone: (opts.branding as any)?.phone ?? (payload.employer as any)?.phone ?? "",
    email: (opts.branding as any)?.email ?? (payload.employer as any)?.email ?? "",
  };

  const ctx: Ctx = {
    doc, fontRegular, fontBold, fontItalic,
    page: null as any, y: 0, pageNum: 0,
    template, payload, branding: opts.branding ?? null,
    employer,
    ...computeLayoutV2(template),
  };

  newPage(ctx);
  drawMasthead(ctx);

  const blocks = template.body?.blocks ?? [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "heading": drawHeading(ctx, block); break;
      case "paragraph": drawParagraph(ctx, block); break;
      case "field_grid": drawFieldGrid(ctx, block); break;
      case "table": drawTable(ctx, block); break;
      case "notes": drawNotes(ctx, block); break;
      case "divider": drawDivider(ctx); break;
      case "spacer": drawSpacer(ctx, block); break;
      case "image": await drawImage(ctx, block); break;
      case "signature_block": drawSignature(ctx, block); break;
      default: /* forward-compat: unknown block type is skipped */ break;
    }
  }

  drawFooterOnAllPages(ctx);
  return await doc.save();
}

// ── Masthead (fixed cross-country layout: org name + title + period) ──

function drawMasthead(ctx: Ctx) {
  const cx = ctx.MARGIN + ctx.CONTENT_W / 2;
  const orgName = s(ctx.employer.name || "").toString().toUpperCase();
  if (orgName) {
    const w = ctx.fontBold.widthOfTextAtSize(orgName, 10);
    ctx.page.drawText(orgName, {
      x: cx - w / 2, y: ctx.y - 10,
      size: 10, font: ctx.fontBold, color: COL.text,
    });
    ctx.y -= 18;
  }
  const title = s(ctx.template.display_name || ctx.template.code).toUpperCase();
  const tw = ctx.fontBold.widthOfTextAtSize(title, FONT_SIZE.h1);
  ctx.page.drawText(title, {
    x: cx - tw / 2, y: ctx.y - FONT_SIZE.h1,
    size: FONT_SIZE.h1, font: ctx.fontBold, color: COL.text,
  });
  ctx.y -= FONT_SIZE.h1 + 6;

  const period = s(ctx.payload.period_label ?? `Fiscal Year ${ctx.payload.fiscal_year}`);
  const pw = ctx.fontRegular.widthOfTextAtSize(period, 10);
  ctx.page.drawText(period, {
    x: cx - pw / 2, y: ctx.y - 10, size: 10, font: ctx.fontRegular, color: COL.muted,
  });
  ctx.y -= 14;

  const cite = [ctx.template.legal_reference, ctx.template.regulation_citation]
    .filter(Boolean).map(s).join(" · ");
  if (cite) {
    const cw = ctx.fontItalic.widthOfTextAtSize(cite, 9);
    ctx.page.drawText(cite, {
      x: cx - cw / 2, y: ctx.y - 9, size: 9, font: ctx.fontItalic, color: COL.muted,
    });
    ctx.y -= 12;
  }
  ctx.y -= 6;
  ctx.page.drawLine({
    start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
    thickness: 1, color: COL.ruleStrong,
  });
  ctx.y -= 12;
}

// ── Heading ──────────────────────────────────────────────────────────

function drawHeading(ctx: Ctx, b: HeadingBlock) {
  const level = b.level ?? 2;
  const size = level === 1 ? FONT_SIZE.h1 : level === 2 ? FONT_SIZE.h2 : FONT_SIZE.h3;
  const font = ctx.fontBold;
  const text = s(b.text).toUpperCase();
  ensureSpace(ctx, size + 14);
  const w = font.widthOfTextAtSize(text, size);
  const x = alignX(ctx, b.align ?? "left", w);
  ctx.page.drawText(text, { x, y: ctx.y - size, size, font, color: COL.text });
  ctx.y -= size + 4;
  if (level >= 2) {
    ctx.page.drawLine({
      start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
      thickness: level === 2 ? 0.5 : 0.3, color: COL.rule,
    });
    ctx.y -= 8;
  } else {
    ctx.y -= 4;
  }
}

// ── Paragraph ────────────────────────────────────────────────────────

function drawParagraph(ctx: Ctx, b: ParagraphBlock) {
  const size = FONT_SIZE.body;
  const font = b.emphasis === "bold" ? ctx.fontBold
    : b.emphasis === "italic" ? ctx.fontItalic
    : ctx.fontRegular;
  const color = b.emphasis === "muted" ? COL.muted : COL.text;
  const lines = wrapToWidth(s(b.text), font, size, ctx.CONTENT_W);
  ensureSpace(ctx, lines.length * (size + 3) + 4);
  for (const line of lines) {
    const w = font.widthOfTextAtSize(line, size);
    const x = alignX(ctx, b.align ?? "left", w);
    ctx.page.drawText(line, { x, y: ctx.y - size, size, font, color });
    ctx.y -= size + 3;
  }
  ctx.y -= 4;
}

function alignX(ctx: Ctx, align: "left" | "center" | "right", contentW: number): number {
  switch (align) {
    case "center": return ctx.MARGIN + ctx.CONTENT_W / 2 - contentW / 2;
    case "right":  return ctx.MARGIN + ctx.CONTENT_W - contentW;
    default:       return ctx.MARGIN;
  }
}

// ── Field grid (N-column label:value) ────────────────────────────────

function drawFieldGrid(ctx: Ctx, b: FieldGridBlock) {
  if (b.title) drawHeading(ctx, { type: "heading", text: b.title, level: 2 });
  const ncols = b.columns ?? 2;
  const source = resolveFieldContext(ctx, b.data_source ?? "employee");
  const currency = ctx.payload.currency ?? "";
  const entries = b.fields
    .map((f) => {
      const raw = pathGet(source, f.key);
      const val = formatValue(raw, f.format, currency);
      return { label: f.label, val, emphasis: f.emphasis };
    })
    .filter((e) => e.val && e.val.trim());
  if (entries.length === 0) return;

  const colW = ctx.CONTENT_W / ncols;
  const rowH = 22;
  const cellPadX = 4;
  for (let i = 0; i < entries.length; i += ncols) {
    ensureSpace(ctx, rowH);
    const yRow = ctx.y;
    for (let c = 0; c < ncols && i + c < entries.length; c++) {
      const e = entries[i + c];
      const x = ctx.MARGIN + c * colW;
      ctx.page.drawText(s(e.label).toUpperCase(), {
        x: x + cellPadX, y: yRow - FONT_SIZE.fieldLabel,
        size: FONT_SIZE.fieldLabel, font: ctx.fontRegular, color: COL.muted,
      });
      const primary = e.emphasis === "primary";
      const vFont = primary ? ctx.fontBold : ctx.fontRegular;
      const vSize = primary ? FONT_SIZE.fieldValuePrimary : FONT_SIZE.fieldValue;
      // Truncate to cell width (label:value grids don't wrap; use notes/paragraph if you need wrap).
      const val = clip(s(e.val), vFont, vSize, colW - cellPadX * 2);
      ctx.page.drawText(val, {
        x: x + cellPadX, y: yRow - FONT_SIZE.fieldLabel - vSize - 2,
        size: vSize, font: vFont, color: COL.text,
      });
    }
    ctx.y -= rowH;
  }
  ctx.y -= 4;
}

function clip(str: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(str, size) <= maxW) return str;
  const ell = "…";
  const ew = font.widthOfTextAtSize(ell, size);
  let out = str;
  while (out.length > 1 && font.widthOfTextAtSize(out, size) + ew > maxW) {
    out = out.slice(0, -1);
  }
  return out + ell;
}

// ── Table engine ─────────────────────────────────────────────────────

interface ResolvedColumn extends TableColumn {
  _width: number;   // resolved pt width after distribution
}

function parseFr(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d+(?:\.\d+)?)\s*fr$/i);
  return m ? Number(m[1]) : null;
}

/**
 * Distribute column widths using a fixed → fr → auto strategy.
 * - Numeric widths are consumed as-is.
 * - `"Nfr"` columns share the remainder in proportion to their N.
 * - `"auto"` columns fall back to header intrinsic width, then share leftover.
 */
export function distributeWidths(
  cols: TableColumn[],
  totalW: number,
  measure: (text: string) => number,
): number[] {
  const n = cols.length;
  const widths = new Array<number>(n).fill(0);
  let remaining = totalW;
  const frs: number[] = [];
  const autoIdx: number[] = [];

  for (let i = 0; i < n; i++) {
    const c = cols[i];
    if (typeof c.width === "number") {
      widths[i] = c.width;
      remaining -= c.width;
    } else if (parseFr(c.width) != null) {
      frs[i] = parseFr(c.width)!;
    } else {
      autoIdx.push(i);
    }
  }

  // Auto columns take their header intrinsic width first (capped).
  const minAuto = 24;
  for (const i of autoIdx) {
    const w = Math.max(minAuto, Math.min(totalW / n * 1.5, measure(cols[i].header)));
    widths[i] = w;
    remaining -= w;
  }

  const frSum = frs.reduce((a, b) => a + (b || 0), 0);
  if (frSum > 0) {
    // fr columns share what's left proportionally.
    const share = Math.max(0, remaining) / frSum;
    for (let i = 0; i < n; i++) {
      if (frs[i] != null) widths[i] = frs[i] * share;
    }
  } else if (autoIdx.length > 0 && remaining !== 0) {
    // no fr columns → auto columns absorb the remainder equally.
    const perAuto = remaining / autoIdx.length;
    for (const i of autoIdx) widths[i] += perAuto;
  } else if (frSum === 0 && autoIdx.length === 0 && remaining !== 0 && n > 0) {
    // all fixed but doesn't add up: split residual equally.
    const per = remaining / n;
    for (let i = 0; i < n; i++) widths[i] += per;
  }
  return widths;
}

function drawTable(ctx: Ctx, b: TableBlock) {
  if (b.title) drawHeading(ctx, { type: "heading", text: b.title, level: 2 });

  const opts = {
    striped: b.options?.striped ?? false,
    padding: b.options?.padding ?? 4,
    wrap: b.options?.wrap ?? true,
    repeat_header: b.options?.repeat_header ?? true,
    line_height: b.options?.line_height ?? 1.25,
    header_bg: b.options?.header_bg ?? true,
  };
  const currency = ctx.payload.currency ?? "";

  // Resolve columns' widths.
  const measureHeader = (t: string) =>
    ctx.fontBold.widthOfTextAtSize(s(t).toUpperCase(), FONT_SIZE.tableHeader) + opts.padding * 2;
  const widths = distributeWidths(b.columns, ctx.CONTENT_W, measureHeader);
  const cols: ResolvedColumn[] = b.columns.map((c, i) => ({ ...c, _width: widths[i] }));

  // Resolve rows: raw source → filter → group_by aggregate → materialise cells.
  const raw = resolveDataSource(ctx, b.data_source);
  const filtered = b.filter
    ? raw.filter((r: any) => new Set(b.filter!.in).has(String(r[b.filter!.key])))
    : raw;

  type Row = { cells: string[]; isFooter?: boolean };
  const rows: Row[] = [];
  const totals: Record<string, number> = {};
  const numericKeys = new Set(cols.filter((c) => c.format === "currency" || c.format === "number").map((c) => c.key));

  if (b.group_by) {
    const groupKey = b.group_by;
    const groups = new Map<string, Record<string, any>>();
    // Determine which column corresponds to the group key so we materialise its label.
    // For "month_index" specifically, the pack-supplied column should have key === "month_index"
    // and format "text"; the resolver above already returns integer month_index.
    for (const r of filtered) {
      const gk = String(r[groupKey] ?? "");
      if (!groups.has(gk)) groups.set(gk, { [groupKey]: r[groupKey] });
      const bucket = groups.get(gk)!;
      for (const c of cols) {
        if (c.key === groupKey) continue;
        if (numericKeys.has(c.key)) {
          if (String(r.rule_code) === c.key) {
            bucket[c.key] = (Number(bucket[c.key]) || 0) + Number(r.employee_amount ?? 0);
          }
        } else if (bucket[c.key] === undefined) {
          bucket[c.key] = r[c.key];
        }
      }
    }
    // Keep group order stable — insertion order.
    for (const bucket of groups.values()) {
      const cells = cols.map((c) => {
        const raw = bucket[c.key];
        const v = formatValue(raw, c.format, currency);
        if (numericKeys.has(c.key)) totals[c.key] = (totals[c.key] || 0) + (Number(raw) || 0);
        return v;
      });
      rows.push({ cells });
    }
  } else {
    for (const r of filtered) {
      const cells = cols.map((c) => {
        const raw = pathGet(r, c.key);
        if (numericKeys.has(c.key)) totals[c.key] = (totals[c.key] || 0) + (Number(raw) || 0);
        return formatValue(raw, c.format, currency);
      });
      rows.push({ cells });
    }
  }

  // Footer row.
  if (b.footer) {
    const includeSet = new Set(b.footer.include_columns ?? Array.from(numericKeys));
    const footerCells = cols.map((c, i) => {
      if (i === 0) return s(b.footer!.label);
      if (includeSet.has(c.key)) return formatValue(totals[c.key] ?? 0, c.format, currency);
      return "";
    });
    rows.push({ cells: footerCells, isFooter: true });
  }

  // Draw with page-break + repeat header.
  const rowSize = FONT_SIZE.tableCell;
  const headerH = FONT_SIZE.tableHeader + opts.padding * 2 + 4;

  const measureRow = (row: Row): number => {
    if (!opts.wrap) return rowSize + opts.padding * 2;
    let maxLines = 1;
    for (let i = 0; i < cols.length; i++) {
      const w = cols[i]._width - opts.padding * 2;
      const lines = wrapToWidth(row.cells[i] ?? "", row.isFooter ? ctx.fontBold : ctx.fontRegular, rowSize, w).length;
      if (lines > maxLines) maxLines = lines;
    }
    return maxLines * rowSize * opts.line_height + opts.padding * 2;
  };

  const drawHeaderRow = () => {
    if (opts.header_bg) {
      ctx.page.drawRectangle({
        x: ctx.MARGIN, y: ctx.y - headerH,
        width: ctx.CONTENT_W, height: headerH, color: COL.bandBg,
      });
    }
    let x = ctx.MARGIN;
    for (const c of cols) {
      const label = s(c.header).toUpperCase();
      const font = ctx.fontBold;
      const lines = wrapToWidth(label, font, FONT_SIZE.tableHeader, c._width - opts.padding * 2);
      // Vertically center header text block.
      const totalLinesH = lines.length * FONT_SIZE.tableHeader * 1.15;
      let ly = ctx.y - headerH / 2 + totalLinesH / 2 - FONT_SIZE.tableHeader;
      for (const line of lines) {
        const lw = font.widthOfTextAtSize(line, FONT_SIZE.tableHeader);
        const align = c.header_align ?? c.align ?? (numericKeys.has(c.key) ? "right" : "left");
        const tx = align === "right" ? x + c._width - lw - opts.padding
          : align === "center" ? x + c._width / 2 - lw / 2
          : x + opts.padding;
        ctx.page.drawText(line, { x: tx, y: ly, size: FONT_SIZE.tableHeader, font, color: COL.text });
        ly -= FONT_SIZE.tableHeader * 1.15;
      }
      x += c._width;
    }
    ctx.y -= headerH;
    ctx.page.drawLine({
      start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
      thickness: 0.6, color: COL.ruleStrong,
    });
  };

  drawHeaderRow();

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    const rh = measureRow(row);
    if (ctx.y - rh < ctx.MARGIN + 30) {
      newPage(ctx);
      if (opts.repeat_header) drawHeaderRow();
    }
    // Zebra background
    if (opts.striped && !row.isFooter && rIdx % 2 === 1) {
      ctx.page.drawRectangle({
        x: ctx.MARGIN, y: ctx.y - rh,
        width: ctx.CONTENT_W, height: rh, color: COL.stripe,
      });
    }
    // Footer top rule
    if (row.isFooter) {
      ctx.page.drawLine({
        start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
        thickness: 0.6, color: COL.ruleStrong,
      });
    }

    const cellTop = ctx.y;
    let x = ctx.MARGIN;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const cellW = c._width;
      const text = row.cells[i] ?? "";
      const font = row.isFooter ? ctx.fontBold : ctx.fontRegular;
      const lines = opts.wrap
        ? wrapToWidth(text, font, rowSize, cellW - opts.padding * 2)
        : [clip(text, font, rowSize, cellW - opts.padding * 2)];
      const align = c.align ?? (numericKeys.has(c.key) ? "right" : "left");
      let ly = cellTop - opts.padding - rowSize;
      for (const line of lines) {
        const lw = font.widthOfTextAtSize(line, rowSize);
        const tx = align === "right" ? x + cellW - lw - opts.padding
          : align === "center" ? x + cellW / 2 - lw / 2
          : x + opts.padding;
        const zero = numericKeys.has(c.key) && Number(pathGetOrZero(text)) === 0;
        ctx.page.drawText(line, {
          x: tx, y: ly, size: rowSize, font,
          color: zero && !row.isFooter ? COL.muted : COL.text,
        });
        ly -= rowSize * opts.line_height;
      }
      x += cellW;
    }
    ctx.y -= rh;
    // Hairline between rows
    if (!row.isFooter) {
      ctx.page.drawLine({
        start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
        thickness: 0.2, color: COL.rule,
      });
    } else {
      ctx.page.drawLine({
        start: { x: ctx.MARGIN, y: ctx.y - 2 }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y - 2 },
        thickness: 0.6, color: COL.ruleStrong,
      });
    }
  }
  ctx.y -= 10;
}

function pathGetOrZero(display: string): string {
  // Helper only to preserve muted-zero styling: attempts to parse the
  // displayed cell string back to a number to detect exact zeros.
  const n = display.replace(/[^\d.\-()]/g, "").replace(/[()]/g, "-");
  return String(Number(n) || 0);
}

// ── Notes ────────────────────────────────────────────────────────────

function drawNotes(ctx: Ctx, b: NotesBlock) {
  const padX = 8, padY = 8;
  const boxW = ctx.CONTENT_W;
  const size = FONT_SIZE.notes;
  const font = b.emphasis === "italic" ? ctx.fontItalic : ctx.fontRegular;
  // Measure content
  const titleH = b.title ? FONT_SIZE.notesTitle + 6 : 0;
  const wrapped = b.paragraphs.map((p) =>
    wrapToWidth(s(p), font, size, boxW - padX * 2)
  );
  const bodyH = wrapped.reduce((acc, lines) => acc + lines.length * (size + 3) + 4, 0);
  const totalH = titleH + bodyH + padY * 2;

  ensureSpace(ctx, totalH);
  if (b.border !== false) {
    ctx.page.drawRectangle({
      x: ctx.MARGIN, y: ctx.y - totalH, width: boxW, height: totalH,
      borderColor: COL.rule, borderWidth: 0.5,
    });
  }
  let cursor = ctx.y - padY;
  if (b.title) {
    ctx.page.drawText(s(b.title).toUpperCase(), {
      x: ctx.MARGIN + padX, y: cursor - FONT_SIZE.notesTitle,
      size: FONT_SIZE.notesTitle, font: ctx.fontBold, color: COL.text,
    });
    cursor -= FONT_SIZE.notesTitle + 6;
  }
  for (const lines of wrapped) {
    for (const line of lines) {
      ctx.page.drawText(line, {
        x: ctx.MARGIN + padX, y: cursor - size,
        size, font, color: COL.text,
      });
      cursor -= size + 3;
    }
    cursor -= 4;
  }
  ctx.y -= totalH + 8;
}

// ── Divider / Spacer / Image / Signature ─────────────────────────────

function drawDivider(ctx: Ctx) {
  ensureSpace(ctx, 12);
  ctx.y -= 6;
  ctx.page.drawLine({
    start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
    thickness: 0.4, color: COL.rule,
  });
  ctx.y -= 6;
}

function drawSpacer(ctx: Ctx, b: SpacerBlock) {
  const h = b.size ?? 8;
  ensureSpace(ctx, h);
  ctx.y -= h;
}

async function drawImage(ctx: Ctx, b: ImageBlock) {
  try {
    const dataUrl = b.data.startsWith("data:") ? b.data : `data:image/png;base64,${b.data}`;
    const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0));
    const isJpg = dataUrl.startsWith("data:image/jpeg") || dataUrl.startsWith("data:image/jpg");
    const img = isJpg ? await ctx.doc.embedJpg(bytes) : await ctx.doc.embedPng(bytes);
    const w = b.width ?? img.width;
    const h = b.height ?? (img.height * (w / img.width));
    ensureSpace(ctx, h + 6);
    const x = alignX(ctx, b.align ?? "left", w);
    ctx.page.drawImage(img, { x, y: ctx.y - h, width: w, height: h });
    ctx.y -= h + 6;
  } catch { /* image failures are non-fatal — treat like a spacer */ ctx.y -= 6; }
}

function drawSignature(ctx: Ctx, b: SignatureBlock) {
  if (b.title) drawHeading(ctx, { type: "heading", text: b.title, level: 2 });
  const slots = b.slots ?? [];
  if (slots.length === 0) return;
  const colW = ctx.CONTENT_W / slots.length;
  const boxH = 52;
  ensureSpace(ctx, boxH + 8);
  slots.forEach((slot, i) => {
    const x = ctx.MARGIN + i * colW;
    ctx.page.drawLine({
      start: { x: x + 4, y: ctx.y - 28 },
      end:   { x: x + colW - 12, y: ctx.y - 28 },
      thickness: 0.6, color: COL.ruleStrong,
    });
    ctx.page.drawText(s(slot.caption).toUpperCase(), {
      x: x + 4, y: ctx.y - 40,
      size: 8, font: ctx.fontBold, color: COL.text,
    });
    if (slot.sub_caption) {
      ctx.page.drawText(s(slot.sub_caption), {
        x: x + 4, y: ctx.y - 50,
        size: 7, font: ctx.fontRegular, color: COL.muted,
      });
    }
  });
  ctx.y -= boxH + 10;
}

// ── Footer on every page ─────────────────────────────────────────────

function drawFooterOnAllPages(ctx: Ctx) {
  const pages = ctx.doc.getPages();
  const total = pages.length;
  const stamp = s(
    `Generated ${ctx.payload.generated_at ?? new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`,
  );
  const serial = ctx.payload.serial_number ? s(`Serial: ${ctx.payload.serial_number}`) : "";
  pages.forEach((p, idx) => {
    const y = ctx.MARGIN - 12;
    p.drawLine({
      start: { x: ctx.MARGIN, y: y + 12 }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: y + 12 },
      thickness: 0.3, color: COL.rule,
    });
    p.drawText(stamp, {
      x: ctx.MARGIN, y, size: FONT_SIZE.footer, font: ctx.fontRegular, color: COL.muted,
    });
    if (serial) {
      const sw = ctx.fontRegular.widthOfTextAtSize(serial, FONT_SIZE.footer);
      p.drawText(serial, {
        x: ctx.MARGIN + ctx.CONTENT_W / 2 - sw / 2, y,
        size: FONT_SIZE.footer, font: ctx.fontRegular, color: COL.muted,
      });
    }
    const pnum = `Page ${idx + 1} of ${total}`;
    const pw = ctx.fontRegular.widthOfTextAtSize(pnum, FONT_SIZE.footer);
    p.drawText(pnum, {
      x: ctx.MARGIN + ctx.CONTENT_W - pw, y,
      size: FONT_SIZE.footer, font: ctx.fontRegular, color: COL.muted,
    });
  });
}
