// @ts-nocheck — Deno runtime
/**
 * returnRenderer — section-based PDF renderer for statutory *returns*
 * (P10, PAYE monthly return, NSSF/SHIF/AHL remittance filings, VAT
 * returns and every future equivalent shipped through the localization
 * pack pipeline).
 *
 * Why not `generateReportPdf`?
 *   Same shallow-output problem the certificate renderer solved: reports
 *   are spreadsheets with a title, but statutory returns are legal
 *   filings with named bands — employer header, period band, employee
 *   line grid, employer totals, reconciliation block, statutory
 *   footnote, signature block. This renderer draws each band from the
 *   `return_template_v2` section vocabulary so what the tax portal
 *   receives matches what the auditor expects.
 *
 * Country-agnostic by construction. Every layout decision comes from
 * `body.sections[]` authored by the pack publisher — no country
 * branches, no rule-code literals.
 *
 * A4 portrait is enforced upstream via `assertStatutoryPaper`.
 *
 * Feature-flagged: `generate-statutory-return` invokes this renderer
 * only when `template.body.renderer === "v2-returns"` (or, equivalently,
 * when the pack version's metadata sets the same flag). Older pack
 * versions continue on `generateReportPdf`.
 */
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import { winansiSafe } from "./winansi.ts";

export interface ReturnSectionSpec {
  type: string;
  title?: string;
  columns?: Array<{ key: string; header?: string; align?: "left" | "right"; format?: "money" | "text" }>;
  body?: string;
  rule_codes?: string[];
}

export interface ReturnTemplateV2 {
  code: string;
  display_name: string;
  legal_reference?: string | null;
  regulation_citation?: string | null;
  authority_name?: string | null;
  body: {
    renderer?: string; // "v2-returns" gate
    sections?: ReturnSectionSpec[];
    footer_note?: string | null;
    columns?: any[]; // legacy — ignored by v2
  } | null;
}

export interface ReturnPayload {
  employer: {
    name?: string | null;
    tax_pin?: string | null;
    address?: string | null;
    tax_office?: string | null;
  };
  period_start: string;
  period_end: string;
  period_label?: string;
  currency?: string;
  rows: Array<Record<string, any>>;
  totals: Record<string, number>;
  reconciliation?: { rule_code: string; expected: number; actual: number; delta: number } | null;
  serial_number?: string;
  generated_at?: string;
}

const MM = 72 / 25.4;
const PAGE_W = 210 * MM;
const PAGE_H = 297 * MM;
const MARGIN = 42;
const CONTENT_W = PAGE_W - MARGIN * 2;

const COL = {
  text: rgb(0.08, 0.08, 0.12),
  muted: rgb(0.42, 0.42, 0.48),
  rule: rgb(0.72, 0.72, 0.78),
  bandBg: rgb(0.965, 0.965, 0.975),
};

const SIZE = {
  documentTitle: 15,
  sectionLabel: 8.5,
  identityLabel: 7,
  identityValue: 9.5,
  tableHeader: 7.5,
  tableCell: 8,
  totalsLabel: 8,
  totalsValue: 10,
  footnote: 8,
  pageFooter: 7,
};

const SECTION_LABELS: Record<string, string> = {
  employer_header: "EMPLOYER",
  period_band: "PERIOD",
  employee_line_grid: "EMPLOYEE LINES",
  employer_totals: "EMPLOYER TOTALS",
  reconciliation_block: "RECONCILIATION",
  signature_block: "SIGNATURE",
  statutory_footnote: "STATUTORY NOTICE",
  remittance_summary: "REMITTANCE",
};

function fmtMoney(v: any, currency?: string): string {
  const n = Number(v ?? 0);
  const s = isFinite(n) ? n.toFixed(2) : "0.00";
  return currency ? `${currency} ${s}` : s;
}

function drawText(page: any, text: string, x: number, y: number, font: any, size: number, color = COL.text) {
  page.drawText(winansiSafe(String(text ?? "")), { x, y, size, font, color });
}

function drawSectionLabel(page: any, label: string, y: number, fontBold: any): number {
  page.drawRectangle({ x: MARGIN, y: y - 14, width: CONTENT_W, height: 14, color: COL.bandBg });
  drawText(page, label, MARGIN + 6, y - 10, fontBold, SIZE.sectionLabel, COL.muted);
  return y - 18;
}

/**
 * True iff the template opts into the v2 section-based renderer.
 * Kept here (not on the caller) so all render sites use the same gate.
 */
export function isReturnTemplateV2(template: ReturnTemplateV2): boolean {
  return template?.body?.renderer === "v2-returns" && Array.isArray(template?.body?.sections);
}

export async function renderReturnPdf(
  template: ReturnTemplateV2,
  payload: ReturnPayload,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  // Title strip
  drawText(page, template.display_name ?? template.code, MARGIN, y - 14, fontBold, SIZE.documentTitle);
  y -= 22;
  drawText(
    page,
    `Period ${payload.period_start} → ${payload.period_end}${template.authority_name ? ` • ${template.authority_name}` : ""}`,
    MARGIN,
    y,
    fontRegular,
    9,
    COL.muted,
  );
  y -= 16;

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN + 30) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };

  const sections = Array.isArray(template.body?.sections) ? template.body!.sections! : [];
  for (const section of sections) {
    ensureSpace(60);
    const label = section.title ?? SECTION_LABELS[section.type] ?? section.type.toUpperCase();
    y = drawSectionLabel(page, label, y, fontBold);

    switch (section.type) {
      case "employer_header": {
        const pairs: Array<[string, string]> = [
          ["Name", String(payload.employer?.name ?? "")],
          ["Tax PIN", String(payload.employer?.tax_pin ?? "")],
          ["Address", String(payload.employer?.address ?? "")],
          ["Tax Office", String(payload.employer?.tax_office ?? "")],
        ];
        for (const [k, v] of pairs) {
          drawText(page, k.toUpperCase(), MARGIN, y - 8, fontRegular, SIZE.identityLabel, COL.muted);
          drawText(page, v, MARGIN + 80, y - 8, fontRegular, SIZE.identityValue);
          y -= 14;
        }
        y -= 4;
        break;
      }
      case "period_band": {
        drawText(page, payload.period_label ?? `${payload.period_start} → ${payload.period_end}`, MARGIN, y - 10, fontBold, SIZE.identityValue);
        y -= 18;
        break;
      }
      case "employee_line_grid": {
        const cols = section.columns ?? [];
        if (!cols.length) { y -= 6; break; }
        const colW = CONTENT_W / cols.length;
        // header
        cols.forEach((c, i) => {
          drawText(page, (c.header ?? c.key).toUpperCase(), MARGIN + i * colW, y - 8, fontBold, SIZE.tableHeader, COL.muted);
        });
        y -= 12;
        page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + CONTENT_W, y }, thickness: 0.5, color: COL.rule });
        y -= 4;
        for (const row of payload.rows) {
          ensureSpace(14);
          cols.forEach((c, i) => {
            const raw = row[c.key];
            const txt = c.format === "money" ? fmtMoney(raw, payload.currency) : String(raw ?? "");
            const x = MARGIN + i * colW + (c.align === "right" ? colW - 4 - (fontRegular.widthOfTextAtSize(txt, SIZE.tableCell)) : 0);
            drawText(page, txt, x, y - 8, fontRegular, SIZE.tableCell);
          });
          y -= 12;
        }
        y -= 4;
        break;
      }
      case "employer_totals": {
        for (const [k, v] of Object.entries(payload.totals ?? {})) {
          drawText(page, `Total ${k}`.toUpperCase(), MARGIN, y - 8, fontRegular, SIZE.totalsLabel, COL.muted);
          drawText(page, fmtMoney(v, payload.currency), MARGIN + 200, y - 8, fontBold, SIZE.totalsValue);
          y -= 14;
        }
        y -= 4;
        break;
      }
      case "reconciliation_block": {
        const r = payload.reconciliation;
        if (r) {
          drawText(page, `Rule ${r.rule_code}`, MARGIN, y - 8, fontBold, SIZE.identityValue);
          y -= 12;
          drawText(page, `Expected: ${fmtMoney(r.expected, payload.currency)}`, MARGIN, y - 8, fontRegular, SIZE.tableCell);
          y -= 12;
          drawText(page, `Actual:   ${fmtMoney(r.actual, payload.currency)}`, MARGIN, y - 8, fontRegular, SIZE.tableCell);
          y -= 12;
          drawText(page, `Delta:    ${fmtMoney(r.delta, payload.currency)}`, MARGIN, y - 8, fontBold, SIZE.tableCell, Math.abs(r.delta) < 0.005 ? COL.text : rgb(0.7, 0.15, 0.15));
          y -= 14;
        } else {
          drawText(page, "No reconciliation configured.", MARGIN, y - 8, fontItalic, SIZE.tableCell, COL.muted);
          y -= 14;
        }
        break;
      }
      case "signature_block": {
        const w = (CONTENT_W - 24) / 2;
        page.drawLine({ start: { x: MARGIN, y: y - 32 }, end: { x: MARGIN + w, y: y - 32 }, thickness: 0.5, color: COL.rule });
        page.drawLine({ start: { x: MARGIN + w + 24, y: y - 32 }, end: { x: MARGIN + CONTENT_W, y: y - 32 }, thickness: 0.5, color: COL.rule });
        drawText(page, "AUTHORISED SIGNATORY", MARGIN, y - 44, fontRegular, SIZE.identityLabel, COL.muted);
        drawText(page, "DATE", MARGIN + w + 24, y - 44, fontRegular, SIZE.identityLabel, COL.muted);
        y -= 54;
        break;
      }
      case "statutory_footnote": {
        const text = String(section.body ?? "");
        const words = text.split(/\s+/);
        let line = "";
        const maxW = CONTENT_W;
        for (const w of words) {
          const candidate = line ? line + " " + w : w;
          if (fontItalic.widthOfTextAtSize(candidate, SIZE.footnote) > maxW) {
            ensureSpace(12);
            drawText(page, line, MARGIN, y - 8, fontItalic, SIZE.footnote, COL.muted);
            y -= 12;
            line = w;
          } else {
            line = candidate;
          }
        }
        if (line) {
          ensureSpace(12);
          drawText(page, line, MARGIN, y - 8, fontItalic, SIZE.footnote, COL.muted);
          y -= 14;
        }
        break;
      }
      case "remittance_summary": {
        drawText(page, `Total remittance: ${fmtMoney(Object.values(payload.totals ?? {}).reduce((a: number, b: any) => a + Number(b || 0), 0), payload.currency)}`,
          MARGIN, y - 8, fontBold, SIZE.totalsValue);
        y -= 16;
        break;
      }
      default: {
        drawText(page, `[unknown section: ${section.type}]`, MARGIN, y - 8, fontItalic, SIZE.tableCell, COL.muted);
        y -= 14;
      }
    }
  }

  // Footer
  const footer = template.body?.footer_note ?? `${template.code} • ${payload.period_start} → ${payload.period_end}`;
  drawText(page, footer, MARGIN, MARGIN - 12, fontRegular, SIZE.pageFooter, COL.muted);

  return await doc.save();
}
