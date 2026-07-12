/**
 * certificateRenderer — browser mirror of
 * `supabase/functions/_shared/pdf/certificateRenderer.ts`.
 *
 * Powers the WYSIWYG preview pane in `CertificateTemplateEditor`. The
 * publisher sees the *exact* PDF the tenant will receive — same section
 * order, same fonts, same margins.
 *
 * ⚠ This file MUST stay in sync with the Deno-side renderer. The
 * parity test in `src/test/localization/certificateRenderer-parity.test.ts`
 * compares the exported function shape + section switch coverage. If
 * you change one file, update the other in the same commit.
 *
 * The only substantive difference from the Deno file is the import
 * source of pdf-lib (npm package here, esm.sh URL over there) and the
 * inline duplication of the shared types so this module has no
 * server-only transitive imports.
 */
import {
  PDFDocument,
  PDFPage,
  PDFFont,
  StandardFonts,
  rgb,
} from "pdf-lib";
import { winansiSafe } from "./winansi";

// ── Shared types (mirror of the Deno-side interfaces) ──────────────

export interface MonthlyRow {
  month_index: number;
  rule_code: string;
  category?: string | null;
  employee_amount: number;
  employer_amount: number;
  taxable_amount: number;
}

export interface OrganizationBrandingLite {
  name?: string | null;
  tax_pin?: string | null;
  address?: string | null;
  tax_office?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface CertificateSectionSpec {
  type: string;
  title?: string;
  include?: string[];
  rule_codes?: string[];
  columns?: Array<string | { key: string; header?: string; format?: string }>;
  body?: string;
}

export interface CertificateTemplate {
  code: string;
  display_name: string;
  legal_reference?: string | null;
  regulation_citation?: string | null;
  effective_date?: string | null;
  authority_name?: string | null;
  body: {
    data_source?: string;
    sections?: CertificateSectionSpec[];
    footer_note?: string | null;
  } | null;
}

export interface CertificatePayload {
  employee: {
    id?: string;
    full_name?: string;
    employee_number?: string | null;
    tax_pin?: string | null;
    national_id?: string | null;
    position?: string | null;
    department?: string | null;
    hire_date?: string | null;
    exit_date?: string | null;
  };
  employer: OrganizationBrandingLite;
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
  branding?: OrganizationBrandingLite | null;
}

// ── Layout (identical to Deno copy) ─────────────────────────────────
//
// See Deno-side comment. Landscape is opted into by
// `body.page.orientation = "landscape"` on the template.

const MM = 72 / 25.4;

export function computeLayout(template: CertificateTemplate): {
  PAGE_W: number; PAGE_H: number; MARGIN: number; CONTENT_W: number;
} {
  const page = (template.body as any)?.page ?? {};
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
} as const;

const SIZE = {
  documentTitle: 16,
  documentSubtitle: 10,
  sectionLabel: 8.5,
  identityLabel: 7,
  identityValue: 9.5,
  identityValueLg: 11,
  tableHeader: 7.5,
  tableCell: 8,
  totalsLabel: 8,
  totalsValue: 10,
  footnote: 8,
  signatureLabel: 8,
  pageFooter: 7,
} as const;

const MONTH_LABELS = [
  "JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC",
];

const SECTION_LABELS: Record<string, string> = {
  employer_header: "EMPLOYER",
  employee_header: "EMPLOYEE",
  fiscal_period_band: "PERIOD",
  monthly_breakdown: "MONTHLY BREAKDOWN",
  ytd_table: "EARNINGS & DEDUCTIONS",
  totals: "YEAR-TO-DATE TOTALS",
  relief_summary: "STATUTORY RELIEF",
  signature_block: "SIGNATURES",
  statutory_footnote: "STATUTORY NOTICE",
};

// ── Renderer ────────────────────────────────────────────────────────

export async function renderCertificatePdf(
  template: CertificateTemplate,
  payload: CertificatePayload,
  opts: RenderOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const ctx: DrawCtx = {
    doc, fontRegular, fontBold, fontItalic,
    page: null as any, y: 0, pageNum: 0,
    template, payload,
    branding: opts.branding ?? null,
  };

  const employer = {
    name: opts.branding?.name ?? payload.employer.name ?? "",
    tax_pin: opts.branding?.tax_pin ?? payload.employer.tax_pin ?? "",
    address: opts.branding?.address ?? payload.employer.address ?? "",
    tax_office: opts.branding?.tax_office ?? payload.employer.tax_office ?? "",
    phone: opts.branding?.phone ?? payload.employer.phone ?? "",
    email: opts.branding?.email ?? payload.employer.email ?? "",
  };

  startPage(ctx);
  drawMasthead(ctx, employer);

  const sections = template.body?.sections ?? [];
  for (const raw of sections) {
    const type = String(raw?.type ?? "").trim();
    if (!type) continue;
    ensureSpace(ctx, 60);
    switch (type) {
      case "employer_header":     drawEmployerSection(ctx, raw, employer); break;
      case "employee_header":     drawEmployeeSection(ctx, raw); break;
      case "fiscal_period_band":  drawFiscalPeriodSection(ctx, raw); break;
      case "monthly_breakdown":   drawMonthlyBreakdown(ctx, raw); break;
      case "ytd_table":           drawYtdTable(ctx, raw); break;
      case "totals":              drawTotalsSection(ctx, raw); break;
      case "relief_summary":      drawReliefSection(ctx, raw); break;
      case "statutory_footnote":  drawFootnote(ctx, raw); break;
      case "signature_block":     drawSignatureBlock(ctx, raw); break;
      default: break;
    }
  }

  drawFooterOnAllPages(ctx);
  return await doc.save();
}

interface DrawCtx {
  doc: PDFDocument;
  fontRegular: PDFFont;
  fontBold: PDFFont;
  fontItalic: PDFFont;
  page: PDFPage;
  y: number;
  pageNum: number;
  template: CertificateTemplate;
  payload: CertificatePayload;
  branding: OrganizationBrandingLite | null;
  PAGE_W: number;
  PAGE_H: number;
  MARGIN: number;
  CONTENT_W: number;
}

function startPage(ctx: DrawCtx): void {
  ctx.page = ctx.doc.addPage([ctx.PAGE_W, ctx.PAGE_H]);
  ctx.pageNum += 1;
  ctx.y = ctx.PAGE_H - ctx.MARGIN;
}

function ensureSpace(ctx: DrawCtx, needed: number): void {
  if (ctx.y - needed < ctx.MARGIN + 30) startPage(ctx);
}

function safe(s: unknown): string { return winansiSafe(s ?? ""); }

function drawMasthead(ctx: DrawCtx, employer: any): void {
  const cx = ctx.MARGIN + ctx.CONTENT_W / 2;
  const orgName = safe(employer.name || "").toUpperCase();
  if (orgName) {
    const w = ctx.fontBold.widthOfTextAtSize(orgName, 10);
    ctx.page.drawText(orgName, {
      x: cx - w / 2, y: ctx.y - 10,
      size: 10, font: ctx.fontBold, color: COL.text,
    });
    ctx.y -= 18;
  }
  const title = safe(ctx.template.display_name || ctx.template.code).toUpperCase();
  const tw = ctx.fontBold.widthOfTextAtSize(title, SIZE.documentTitle);
  ctx.page.drawText(title, {
    x: cx - tw / 2, y: ctx.y - SIZE.documentTitle,
    size: SIZE.documentTitle, font: ctx.fontBold, color: COL.text,
  });
  ctx.y -= SIZE.documentTitle + 6;

  const period = safe(ctx.payload.period_label ?? `Fiscal Year ${ctx.payload.fiscal_year}`);
  const pw = ctx.fontRegular.widthOfTextAtSize(period, SIZE.documentSubtitle);
  ctx.page.drawText(period, {
    x: cx - pw / 2, y: ctx.y - SIZE.documentSubtitle,
    size: SIZE.documentSubtitle, font: ctx.fontRegular, color: COL.muted,
  });
  ctx.y -= SIZE.documentSubtitle + 4;

  const cite = [ctx.template.legal_reference, ctx.template.regulation_citation]
    .filter(Boolean).map(safe).join(" \u00B7 ");
  if (cite) {
    const cw = ctx.fontItalic.widthOfTextAtSize(cite, SIZE.documentSubtitle - 1);
    ctx.page.drawText(cite, {
      x: cx - cw / 2, y: ctx.y - (SIZE.documentSubtitle - 1),
      size: SIZE.documentSubtitle - 1, font: ctx.fontItalic, color: COL.muted,
    });
    ctx.y -= SIZE.documentSubtitle + 4;
  }

  ctx.y -= 6;
  ctx.page.drawLine({
    start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
    thickness: 1, color: COL.ruleStrong,
  });
  ctx.y -= 14;
}

function drawSectionLabel(ctx: DrawCtx, type: string, override?: string): void {
  const label = safe(override || SECTION_LABELS[type] || type).toUpperCase();
  ctx.page.drawText(label, {
    x: ctx.MARGIN, y: ctx.y - SIZE.sectionLabel,
    size: SIZE.sectionLabel, font: ctx.fontBold, color: COL.muted,
  });
  ctx.y -= SIZE.sectionLabel + 3;
  ctx.page.drawLine({
    start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
    thickness: 0.4, color: COL.rule,
  });
  ctx.y -= 8;
}

const LABEL_MAP: Record<string, string> = {
  name: "Registered Name", tax_pin: "Tax PIN", address: "Address",
  tax_office: "Tax Office", phone: "Phone", email: "Email",
  full_name: "Full Name", employee_number: "Employee No.",
  national_id: "National ID", position: "Position", department: "Department",
  hire_date: "Hire Date", exit_date: "Exit Date",
};

function humanKey(k: string): string {
  return LABEL_MAP[k] || k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function drawIdentityGrid(
  ctx: DrawCtx,
  entries: Array<{ key: string; value: string }>,
): void {
  const colW = ctx.CONTENT_W / 2;
  const cellPadX = 4;
  const rowH = 22;
  const filtered = entries.filter((e) => e.value && e.value.trim());
  for (let i = 0; i < filtered.length; i += 2) {
    ensureSpace(ctx, rowH + 4);
    const yRow = ctx.y;
    for (let col = 0; col < 2 && i + col < filtered.length; col++) {
      const e = filtered[i + col];
      const x = ctx.MARGIN + col * colW;
      ctx.page.drawText(safe(humanKey(e.key)).toUpperCase(), {
        x: x + cellPadX, y: yRow - SIZE.identityLabel,
        size: SIZE.identityLabel, font: ctx.fontRegular, color: COL.muted,
      });
      const isPrimary = e.key === "name" || e.key === "full_name";
      const vFont = isPrimary ? ctx.fontBold : ctx.fontRegular;
      const vSize = isPrimary ? SIZE.identityValueLg : SIZE.identityValue;
      const value = truncateToWidth(safe(e.value), vFont, vSize, colW - cellPadX * 2);
      ctx.page.drawText(value, {
        x: x + cellPadX, y: yRow - SIZE.identityLabel - vSize - 2,
        size: vSize, font: vFont, color: COL.text,
      });
    }
    ctx.y -= rowH;
  }
  ctx.y -= 6;
}

function truncateToWidth(s: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(s, size) <= maxW) return s;
  const ell = "...";
  const ellW = font.widthOfTextAtSize(ell, size);
  let out = s;
  while (out.length > 1 && font.widthOfTextAtSize(out, size) + ellW > maxW) {
    out = out.slice(0, -1);
  }
  return out + ell;
}

function drawEmployerSection(ctx: DrawCtx, spec: CertificateSectionSpec, employer: any): void {
  drawSectionLabel(ctx, "employer_header", spec.title);
  const includes = spec.include && spec.include.length
    ? spec.include : ["name", "tax_pin", "address", "tax_office"];
  drawIdentityGrid(ctx, includes.map((k) => ({ key: k, value: String(employer[k] ?? "") })));
}

function drawEmployeeSection(ctx: DrawCtx, spec: CertificateSectionSpec): void {
  drawSectionLabel(ctx, "employee_header", spec.title);
  const e = ctx.payload.employee;
  const includes = spec.include && spec.include.length
    ? spec.include
    : ["full_name", "employee_number", "tax_pin", "national_id", "position", "department"];
  const entries = includes.map((k) => ({ key: k, value: String((e as any)[k] ?? "") }));
  drawIdentityGrid(ctx, entries);
}

function drawFiscalPeriodSection(ctx: DrawCtx, spec: CertificateSectionSpec): void {
  drawSectionLabel(ctx, "fiscal_period_band", spec.title);
  const label = safe(ctx.payload.period_label ?? `Fiscal Year ${ctx.payload.fiscal_year}`);
  ctx.page.drawText(label, {
    x: ctx.MARGIN + 4, y: ctx.y - SIZE.identityValue,
    size: SIZE.identityValue, font: ctx.fontBold, color: COL.text,
  });
  ctx.y -= SIZE.identityValue + 12;
}

function drawMonthlyBreakdown(ctx: DrawCtx, spec: CertificateSectionSpec): void {
  drawSectionLabel(ctx, "monthly_breakdown", spec.title);
  const cols = (spec.columns && spec.columns.length ? spec.columns : (spec.rule_codes ?? []))
    .map((c: any) => (typeof c === "string"
      ? { key: c, header: humanKey(c) }
      : { key: String(c.key ?? c.rule_code ?? ""), header: String(c.header ?? humanKey(c.key ?? "")) }))
    .filter((c: any) => c.key);
  if (cols.length === 0) { drawEmpty(ctx, "No monthly columns defined."); return; }

  const monthColW = 40;
  const dataW = ctx.CONTENT_W - monthColW;
  const cellW = dataW / cols.length;
  const headerH = 20;
  ensureSpace(ctx, headerH + 14 * 13 + 10);
  ctx.page.drawRectangle({
    x: ctx.MARGIN, y: ctx.y - headerH, width: ctx.CONTENT_W, height: headerH, color: COL.bandBg,
  });
  ctx.page.drawText("MONTH", {
    x: ctx.MARGIN + 4, y: ctx.y - headerH / 2 - SIZE.tableHeader / 2 + 1,
    size: SIZE.tableHeader, font: ctx.fontBold, color: COL.text,
  });
  cols.forEach((c: any, i: number) => {
    const cellX = ctx.MARGIN + monthColW + i * cellW;
    const label = safe(c.header).toUpperCase();
    const lw = ctx.fontBold.widthOfTextAtSize(label, SIZE.tableHeader);
    const maxLw = cellW - 6;
    let sizeLbl: number = SIZE.tableHeader;
    if (lw > maxLw) sizeLbl = Math.max(6, SIZE.tableHeader * (maxLw / lw));
    const finalW = ctx.fontBold.widthOfTextAtSize(label, sizeLbl);
    ctx.page.drawText(label, {
      x: cellX + cellW - finalW - 4,
      y: ctx.y - headerH / 2 - sizeLbl / 2 + 1,
      size: sizeLbl, font: ctx.fontBold, color: COL.text,
    });
  });
  ctx.y -= headerH;
  ctx.page.drawLine({
    start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
    thickness: 0.6, color: COL.ruleStrong,
  });

  const pivot = new Map<number, Record<string, number>>();
  for (let m = 1; m <= 12; m++) pivot.set(m, {});
  const wanted = new Set(cols.map((c: any) => c.key));
  for (const r of ctx.payload.monthly ?? []) {
    if (!wanted.has(r.rule_code)) continue;
    const b = pivot.get(r.month_index);
    if (!b) continue;
    b[r.rule_code] = (b[r.rule_code] ?? 0) + Number(r.employee_amount || 0);
  }

  const rowH = 14;
  const totals: Record<string, number> = Object.fromEntries(cols.map((c: any) => [c.key, 0]));
  for (let m = 1; m <= 12; m++) {
    ensureSpace(ctx, rowH);
    ctx.y -= rowH;
    ctx.page.drawText(MONTH_LABELS[m - 1], {
      x: ctx.MARGIN + 4, y: ctx.y + 3,
      size: SIZE.tableCell, font: ctx.fontRegular, color: COL.text,
    });
    const bucket = pivot.get(m) ?? {};
    cols.forEach((c: any, i: number) => {
      const val = Number(bucket[c.key] ?? 0);
      totals[c.key] += val;
      const cellX = ctx.MARGIN + monthColW + i * cellW;
      const s = fmtMoney(val);
      const w = ctx.fontRegular.widthOfTextAtSize(s, SIZE.tableCell);
      ctx.page.drawText(s, {
        x: cellX + cellW - w - 4, y: ctx.y + 3,
        size: SIZE.tableCell, font: ctx.fontRegular,
        color: val === 0 ? COL.muted : COL.text,
      });
    });
    ctx.page.drawLine({
      start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
      thickness: 0.2, color: COL.rule,
    });
  }

  ensureSpace(ctx, rowH + 4);
  ctx.y -= 2;
  ctx.page.drawLine({
    start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
    thickness: 0.6, color: COL.ruleStrong,
  });
  ctx.y -= rowH;
  ctx.page.drawText("TOTAL", {
    x: ctx.MARGIN + 4, y: ctx.y + 3,
    size: SIZE.tableCell, font: ctx.fontBold, color: COL.text,
  });
  cols.forEach((c: any, i: number) => {
    const cellX = ctx.MARGIN + monthColW + i * cellW;
    const s = fmtMoney(totals[c.key]);
    const w = ctx.fontBold.widthOfTextAtSize(s, SIZE.tableCell);
    ctx.page.drawText(s, {
      x: cellX + cellW - w - 4, y: ctx.y + 3,
      size: SIZE.tableCell, font: ctx.fontBold, color: COL.text,
    });
  });
  ctx.page.drawLine({
    start: { x: ctx.MARGIN, y: ctx.y - 1 }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y - 1 },
    thickness: 0.2, color: COL.rule,
  });
  ctx.page.drawLine({
    start: { x: ctx.MARGIN, y: ctx.y - 3 }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y - 3 },
    thickness: 0.6, color: COL.ruleStrong,
  });
  ctx.y -= 14;
}

function drawYtdTable(ctx: DrawCtx, spec: CertificateSectionSpec): void {
  drawSectionLabel(ctx, "ytd_table", spec.title);
  const rows = ctx.payload.ytdRows ?? [];
  if (rows.length === 0) { drawEmpty(ctx, "No year-to-date entries."); return; }
  const cols = [
    { key: "rule_code", header: "Rule Code", w: 0.30, align: "left" as const },
    { key: "category", header: "Category", w: 0.25, align: "left" as const },
    { key: "employee_amount", header: "Employee", w: 0.15, align: "right" as const },
    { key: "employer_amount", header: "Employer", w: 0.15, align: "right" as const },
    { key: "taxable_amount", header: "Taxable", w: 0.15, align: "right" as const },
  ];
  const widths = cols.map((c) => c.w * ctx.CONTENT_W);
  const headerH = 18;
  ctx.page.drawRectangle({
    x: ctx.MARGIN, y: ctx.y - headerH, width: ctx.CONTENT_W, height: headerH, color: COL.bandBg,
  });
  let cx = ctx.MARGIN;
  cols.forEach((c, i) => {
    const s = safe(c.header).toUpperCase();
    const w = widths[i];
    const tw = ctx.fontBold.widthOfTextAtSize(s, SIZE.tableHeader);
    const tx = c.align === "right" ? cx + w - tw - 4 : cx + 4;
    ctx.page.drawText(s, {
      x: tx, y: ctx.y - headerH / 2 - SIZE.tableHeader / 2 + 1,
      size: SIZE.tableHeader, font: ctx.fontBold, color: COL.text,
    });
    cx += w;
  });
  ctx.y -= headerH;
  ctx.page.drawLine({
    start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
    thickness: 0.6, color: COL.ruleStrong,
  });
  const rowH = 14;
  for (const r of rows) {
    ensureSpace(ctx, rowH);
    ctx.y -= rowH;
    let cx2 = ctx.MARGIN;
    cols.forEach((c, i) => {
      const w = widths[i];
      const raw = (r as any)[c.key];
      const s = safe(c.align === "right" ? fmtMoney(Number(raw || 0)) : String(raw ?? ""));
      const tw = ctx.fontRegular.widthOfTextAtSize(s, SIZE.tableCell);
      const tx = c.align === "right" ? cx2 + w - tw - 4 : cx2 + 4;
      ctx.page.drawText(truncateToWidth(s, ctx.fontRegular, SIZE.tableCell, w - 6), {
        x: tx, y: ctx.y + 3,
        size: SIZE.tableCell, font: ctx.fontRegular, color: COL.text,
      });
      cx2 += w;
    });
    ctx.page.drawLine({
      start: { x: ctx.MARGIN, y: ctx.y }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: ctx.y },
      thickness: 0.2, color: COL.rule,
    });
  }
  ctx.y -= 8;
}

function drawTotalsSection(ctx: DrawCtx, spec: CertificateSectionSpec): void {
  drawSectionLabel(ctx, "totals", spec.title);
  const items = [
    { label: "Total Employee Deductions", value: ctx.payload.totals.employee },
    { label: "Total Employer Contributions", value: ctx.payload.totals.employer },
    { label: "Total Taxable Income", value: ctx.payload.totals.taxable },
  ];
  const colW = ctx.CONTENT_W / items.length;
  const boxH = 40;
  ensureSpace(ctx, boxH + 8);
  ctx.page.drawRectangle({
    x: ctx.MARGIN, y: ctx.y - boxH, width: ctx.CONTENT_W, height: boxH, color: COL.bandBg,
  });
  items.forEach((it, i) => {
    const x = ctx.MARGIN + i * colW;
    const lbl = safe(it.label).toUpperCase();
    ctx.page.drawText(lbl, {
      x: x + 8, y: ctx.y - 12,
      size: SIZE.totalsLabel - 1, font: ctx.fontRegular, color: COL.muted,
    });
    const v = fmtMoney(it.value);
    ctx.page.drawText(v, {
      x: x + 8, y: ctx.y - 32,
      size: SIZE.totalsValue + 2, font: ctx.fontBold, color: COL.text,
    });
    if (i < items.length - 1) {
      ctx.page.drawLine({
        start: { x: x + colW, y: ctx.y - 4 },
        end:   { x: x + colW, y: ctx.y - boxH + 4 },
        thickness: 0.3, color: COL.rule,
      });
    }
  });
  ctx.y -= boxH + 12;
}

function drawReliefSection(ctx: DrawCtx, spec: CertificateSectionSpec): void {
  drawSectionLabel(ctx, "relief_summary", spec.title);
  const codes = spec.rule_codes && spec.rule_codes.length
    ? spec.rule_codes : ["personal_relief", "insurance_relief"];
  const entries = codes.map((code) => {
    const row = ctx.payload.ytdRows.find((r) => r.rule_code === code);
    return { code, amount: Number(row?.employee_amount ?? 0) };
  });
  const colW = ctx.CONTENT_W / entries.length;
  const boxH = 30;
  ensureSpace(ctx, boxH + 8);
  entries.forEach((e, i) => {
    const x = ctx.MARGIN + i * colW;
    ctx.page.drawText(safe(humanKey(e.code)).toUpperCase(), {
      x: x + 4, y: ctx.y - 10,
      size: SIZE.identityLabel, font: ctx.fontRegular, color: COL.muted,
    });
    ctx.page.drawText(fmtMoney(e.amount), {
      x: x + 4, y: ctx.y - 26,
      size: SIZE.totalsValue, font: ctx.fontBold, color: COL.text,
    });
  });
  ctx.y -= boxH + 10;
}

function drawFootnote(ctx: DrawCtx, spec: CertificateSectionSpec): void {
  const text = safe(spec.body ?? "").trim();
  if (!text) return;
  drawSectionLabel(ctx, "statutory_footnote", spec.title);
  const wrapped = wrapText(text, ctx.fontRegular, SIZE.footnote, ctx.CONTENT_W - 8);
  ensureSpace(ctx, wrapped.length * (SIZE.footnote + 3) + 8);
  for (const line of wrapped) {
    ctx.page.drawText(line, {
      x: ctx.MARGIN + 4, y: ctx.y - SIZE.footnote,
      size: SIZE.footnote, font: ctx.fontItalic, color: COL.text,
    });
    ctx.y -= SIZE.footnote + 3;
  }
  ctx.y -= 8;
}

function drawSignatureBlock(ctx: DrawCtx, spec: CertificateSectionSpec): void {
  drawSectionLabel(ctx, "signature_block", spec.title);
  const entries = spec.include && spec.include.length
    ? spec.include : ["preparer", "date", "employer_stamp"];
  const colW = ctx.CONTENT_W / entries.length;
  const boxH = 46;
  ensureSpace(ctx, boxH + 8);
  entries.forEach((k, i) => {
    const x = ctx.MARGIN + i * colW;
    ctx.page.drawLine({
      start: { x: x + 4, y: ctx.y - 26 },
      end:   { x: x + colW - 12, y: ctx.y - 26 },
      thickness: 0.6, color: COL.ruleStrong,
    });
    ctx.page.drawText(safe(humanKey(k)).toUpperCase(), {
      x: x + 4, y: ctx.y - 38,
      size: SIZE.signatureLabel - 1, font: ctx.fontRegular, color: COL.muted,
    });
  });
  ctx.y -= boxH + 10;
}

function drawFooterOnAllPages(ctx: DrawCtx): void {
  const pages = ctx.doc.getPages();
  const total = pages.length;
  const stamp = safe(
    `Generated ${ctx.payload.generated_at ?? new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`,
  );
  const serial = ctx.payload.serial_number ? safe(`Serial: ${ctx.payload.serial_number}`) : "";
  pages.forEach((p, idx) => {
    const y = ctx.MARGIN - 12;
    p.drawLine({
      start: { x: ctx.MARGIN, y: y + 12 }, end: { x: ctx.MARGIN + ctx.CONTENT_W, y: y + 12 },
      thickness: 0.3, color: COL.rule,
    });
    p.drawText(stamp, {
      x: ctx.MARGIN, y, size: SIZE.pageFooter, font: ctx.fontRegular, color: COL.muted,
    });
    if (serial) {
      const sw = ctx.fontRegular.widthOfTextAtSize(serial, SIZE.pageFooter);
      p.drawText(serial, {
        x: ctx.MARGIN + ctx.CONTENT_W / 2 - sw / 2, y,
        size: SIZE.pageFooter, font: ctx.fontRegular, color: COL.muted,
      });
    }
    const pnum = `Page ${idx + 1} of ${total}`;
    const pw = ctx.fontRegular.widthOfTextAtSize(pnum, SIZE.pageFooter);
    p.drawText(pnum, {
      x: ctx.MARGIN + ctx.CONTENT_W - pw, y,
      size: SIZE.pageFooter, font: ctx.fontRegular, color: COL.muted,
    });
  });
}

function fmtMoney(n: number): string {
  const v = Number(n) || 0;
  const negative = v < 0;
  const abs = Math.abs(v);
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return negative ? `(${s})` : s;
}

function drawEmpty(ctx: DrawCtx, msg: string): void {
  ctx.page.drawText(safe(msg), {
    x: ctx.MARGIN + 4, y: ctx.y - SIZE.tableCell,
    size: SIZE.tableCell, font: ctx.fontItalic, color: COL.muted,
  });
  ctx.y -= SIZE.tableCell + 12;
}

function wrapText(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(trial, size) <= maxW) cur = trial;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
