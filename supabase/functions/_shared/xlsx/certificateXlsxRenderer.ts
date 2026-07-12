// @ts-nocheck — Deno runtime
/**
 * certificateXlsxRenderer — editable-Excel twin of `certificateRenderer.ts`.
 *
 * Same input, same source of truth (v2 `body.sections[]` from the pack
 * template + the resolved payload). Different output: an ExcelJS
 * workbook that reproduces the certificate as a spreadsheet a payroll
 * auditor can open and edit. Totals are emitted as `=SUM(...)` formulas
 * so the workbook is "live" in the Odoo `report_xlsx` sense — change a
 * cell and the totals recalc.
 *
 * The mapping between section kinds and worksheet regions mirrors what
 * the PDF renderer draws, so a P9 rendered in both formats has the
 * same layout order and the same numbers to the cent.
 *
 * Country-agnostic. No `if (country === 'KE')`.
 */
import ExcelJS from "npm:exceljs@4.4.0";
import type { CertificatePayload, CertificateTemplate } from "../pdf/certificateRenderer.ts";
import type { MonthlyRow } from "../certificateSections.ts";

const MONTH_LABELS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

const COLUMN_ID_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function colLetter(idx: number): string {
  // 0-indexed → A, B, ... AA. Enough for 26*27 columns which we never hit.
  if (idx < 26) return COLUMN_ID_LETTERS[idx];
  const hi = Math.floor(idx / 26) - 1;
  const lo = idx % 26;
  return COLUMN_ID_LETTERS[hi] + COLUMN_ID_LETTERS[lo];
}

function humanKey(k: string): string {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface MonthlyColSpec { key: string; header: string; format?: string }

function normaliseMonthlyColumns(spec: any): MonthlyColSpec[] {
  const raw = (spec?.columns && spec.columns.length) ? spec.columns : (spec?.rule_codes ?? []);
  return (raw as any[])
    .map((c) => (typeof c === "string"
      ? { key: c, header: humanKey(c) }
      : {
          key: String(c.key ?? c.rule_code ?? ""),
          header: String(c.header ?? humanKey(c.key ?? c.rule_code ?? "")),
          format: c.format,
        }))
    .filter((c) => c.key) as MonthlyColSpec[];
}

const MONEY_FMT = "#,##0.00;(#,##0.00);-";

export async function renderCertificateXlsx(
  template: CertificateTemplate,
  payload: CertificatePayload,
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Localization Pack";
  wb.created = new Date();
  wb.properties.date1904 = false;

  const ws = wb.addWorksheet(template.code || "Certificate", {
    pageSetup: {
      paperSize: 9, // A4
      orientation: "portrait",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
    views: [{ state: "normal", showGridLines: false }],
  });

  let row = 1;
  // ── Masthead ────────────────────────────────────────────────────────
  ws.getCell(`A${row}`).value = (template.display_name || template.code || "Statutory Certificate").toUpperCase();
  ws.getCell(`A${row}`).font = { bold: true, size: 14 };
  ws.mergeCells(`A${row}:G${row}`);
  row += 1;
  if (template.authority_name || template.legal_reference) {
    const parts: string[] = [];
    if (template.authority_name) parts.push(template.authority_name);
    if (template.legal_reference) parts.push(template.legal_reference);
    ws.getCell(`A${row}`).value = parts.join(" · ");
    ws.getCell(`A${row}`).font = { italic: true, size: 9, color: { argb: "FF666B78" } };
    ws.mergeCells(`A${row}:G${row}`);
    row += 1;
  }
  if (payload.serial_number) {
    ws.getCell(`A${row}`).value = `Serial: ${payload.serial_number}`;
    ws.getCell(`A${row}`).font = { size: 8, color: { argb: "FF666B78" } };
    ws.mergeCells(`A${row}:G${row}`);
    row += 1;
  }
  row += 1;

  const sections = template.body?.sections ?? [];
  for (const raw of sections) {
    const type = String(raw?.type ?? "").trim();
    if (!type) continue;
    switch (type) {
      case "employer_header":
        row = writeEmployerHeader(ws, row, payload);
        break;
      case "employee_header":
        row = writeEmployeeHeader(ws, row, payload);
        break;
      case "fiscal_period_band":
        row = writeFiscalPeriod(ws, row, payload);
        break;
      case "monthly_breakdown":
        row = writeMonthlyBreakdown(ws, row, raw, payload);
        break;
      case "ytd_table":
        row = writeYtdTable(ws, row, payload);
        break;
      case "totals":
        row = writeTotals(ws, row, payload);
        break;
      case "relief_summary":
        row = writeReliefSummary(ws, row, payload);
        break;
      case "statutory_footnote":
        row = writeFootnote(ws, row, raw, template);
        break;
      case "signature_block":
        row = writeSignatureBlock(ws, row);
        break;
      default:
        break;
    }
    row += 1;
  }

  ws.getColumn(1).width = 22;
  for (let i = 2; i <= 18; i++) ws.getColumn(i).width = 14;

  const out = await wb.xlsx.writeBuffer();
  return new Uint8Array(out as ArrayBuffer);
}

// ── Section writers ──────────────────────────────────────────────────

function sectionLabel(ws: any, row: number, label: string): number {
  ws.getCell(`A${row}`).value = label;
  ws.getCell(`A${row}`).font = { bold: true, size: 8.5, color: { argb: "FF555A66" } };
  ws.getCell(`A${row}`).alignment = { vertical: "middle" };
  ws.mergeCells(`A${row}:G${row}`);
  return row + 1;
}

function writeKV(ws: any, row: number, pairs: Array<[string, unknown]>): number {
  for (const [label, value] of pairs) {
    ws.getCell(`A${row}`).value = label;
    ws.getCell(`A${row}`).font = { size: 7, color: { argb: "FF666B78" } };
    ws.getCell(`B${row}`).value = value == null ? "" : String(value);
    ws.getCell(`B${row}`).font = { size: 10, bold: true };
    ws.mergeCells(`B${row}:D${row}`);
    row += 1;
  }
  return row;
}

function writeEmployerHeader(ws: any, row: number, payload: CertificatePayload): number {
  row = sectionLabel(ws, row, "EMPLOYER");
  return writeKV(ws, row, [
    ["Employer's Name", payload.employer.name ?? ""],
    ["Employer's PIN / Tax ID", payload.employer.tax_pin ?? ""],
    ["Tax Office", payload.employer.tax_office ?? ""],
    ["Address", payload.employer.address ?? ""],
  ]);
}

function writeEmployeeHeader(ws: any, row: number, payload: CertificatePayload): number {
  row = sectionLabel(ws, row, "EMPLOYEE");
  return writeKV(ws, row, [
    ["Employee's Name", payload.employee.full_name ?? ""],
    ["Employee's PIN / Tax ID", payload.employee.tax_pin ?? ""],
    ["Employee Number", payload.employee.employee_number ?? ""],
    ["National ID", payload.employee.national_id ?? ""],
    ["Position", payload.employee.position ?? ""],
    ["Department", payload.employee.department ?? ""],
  ]);
}

function writeFiscalPeriod(ws: any, row: number, payload: CertificatePayload): number {
  row = sectionLabel(ws, row, "PERIOD");
  return writeKV(ws, row, [
    ["Fiscal Year", String(payload.fiscal_year)],
    ["Period", payload.period_label ?? `1 Jan ${payload.fiscal_year} — 31 Dec ${payload.fiscal_year}`],
    ["Currency", payload.currency ?? ""],
  ]);
}

function writeMonthlyBreakdown(
  ws: any,
  startRow: number,
  spec: any,
  payload: CertificatePayload,
): number {
  let row = sectionLabel(ws, startRow, (spec?.title ?? "Monthly Breakdown").toString().toUpperCase());

  const cols = normaliseMonthlyColumns(spec);
  if (cols.length === 0) {
    ws.getCell(`A${row}`).value = "No monthly columns defined.";
    return row + 1;
  }

  // Header row: MONTH | col1 | col2 | ...
  const headerRow = row;
  ws.getCell(`A${headerRow}`).value = "MONTH";
  ws.getCell(`A${headerRow}`).font = { bold: true, size: 8 };
  ws.getCell(`A${headerRow}`).alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  ws.getCell(`A${headerRow}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F7" } };
  cols.forEach((c, i) => {
    const cell = ws.getCell(`${colLetter(i + 1)}${headerRow}`);
    cell.value = c.header;
    cell.font = { bold: true, size: 8 };
    cell.alignment = { horizontal: "right", vertical: "middle", wrapText: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F7" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FF555A66" } } };
  });
  ws.getRow(headerRow).height = 28;
  row += 1;

  // Pivot payload.monthly by (month_index, rule_code)
  const pivot = new Map<number, Record<string, number>>();
  for (let m = 1; m <= 12; m++) pivot.set(m, {});
  const wanted = new Set(cols.map((c) => c.key));
  for (const r of (payload.monthly ?? []) as MonthlyRow[]) {
    if (!wanted.has(r.rule_code)) continue;
    const b = pivot.get(r.month_index);
    if (!b) continue;
    b[r.rule_code] = (b[r.rule_code] ?? 0) + Number(r.employee_amount || 0);
  }

  const firstDataRow = row;
  for (let m = 1; m <= 12; m++) {
    ws.getCell(`A${row}`).value = MONTH_LABELS[m - 1];
    ws.getCell(`A${row}`).font = { size: 9 };
    const bucket = pivot.get(m) ?? {};
    cols.forEach((c, i) => {
      const cell = ws.getCell(`${colLetter(i + 1)}${row}`);
      cell.value = Number(bucket[c.key] ?? 0);
      cell.numFmt = MONEY_FMT;
      cell.font = { size: 9 };
      cell.alignment = { horizontal: "right" };
    });
    row += 1;
  }
  const lastDataRow = row - 1;

  // TOTAL row — `=SUM(<col><first>:<col><last>)` so the workbook stays "live".
  ws.getCell(`A${row}`).value = "TOTAL";
  ws.getCell(`A${row}`).font = { bold: true, size: 9 };
  ws.getCell(`A${row}`).border = { top: { style: "medium", color: { argb: "FF555A66" } } };
  cols.forEach((_c, i) => {
    const cLetter = colLetter(i + 1);
    const cell = ws.getCell(`${cLetter}${row}`);
    cell.value = { formula: `SUM(${cLetter}${firstDataRow}:${cLetter}${lastDataRow})` };
    cell.numFmt = MONEY_FMT;
    cell.font = { bold: true, size: 9 };
    cell.alignment = { horizontal: "right" };
    cell.border = { top: { style: "medium", color: { argb: "FF555A66" } } };
  });
  row += 1;
  return row;
}

function writeYtdTable(ws: any, startRow: number, payload: CertificatePayload): number {
  let row = sectionLabel(ws, startRow, "YEAR-TO-DATE EARNINGS & DEDUCTIONS");
  ws.getCell(`A${row}`).value = "Rule Code";
  ws.getCell(`B${row}`).value = "Category";
  ws.getCell(`C${row}`).value = "Employee";
  ws.getCell(`D${row}`).value = "Employer";
  ws.getCell(`E${row}`).value = "Taxable";
  for (let i = 0; i < 5; i++) {
    const cell = ws.getCell(`${colLetter(i)}${row}`);
    cell.font = { bold: true, size: 8 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F7" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FF555A66" } } };
  }
  row += 1;
  for (const r of payload.ytdRows ?? []) {
    ws.getCell(`A${row}`).value = r.rule_code;
    ws.getCell(`B${row}`).value = r.category ?? "";
    for (const [i, val] of [Number(r.employee_amount) || 0, Number(r.employer_amount) || 0, Number(r.taxable_amount) || 0].entries()) {
      const cell = ws.getCell(`${colLetter(i + 2)}${row}`);
      cell.value = val;
      cell.numFmt = MONEY_FMT;
      cell.alignment = { horizontal: "right" };
    }
    row += 1;
  }
  return row;
}

function writeTotals(ws: any, startRow: number, payload: CertificatePayload): number {
  let row = sectionLabel(ws, startRow, "YEAR-TO-DATE TOTALS");
  const pairs: Array<[string, number]> = [
    ["Employee (deductions)", Number(payload.totals?.employee) || 0],
    ["Employer (contributions)", Number(payload.totals?.employer) || 0],
    ["Taxable income", Number(payload.totals?.taxable) || 0],
  ];
  for (const [label, val] of pairs) {
    ws.getCell(`A${row}`).value = label;
    ws.getCell(`A${row}`).font = { size: 9 };
    const cell = ws.getCell(`B${row}`);
    cell.value = val;
    cell.numFmt = MONEY_FMT;
    cell.font = { bold: true, size: 10 };
    cell.alignment = { horizontal: "right" };
    row += 1;
  }
  return row;
}

function writeReliefSummary(ws: any, startRow: number, _payload: CertificatePayload): number {
  let row = sectionLabel(ws, startRow, "STATUTORY RELIEF");
  ws.getCell(`A${row}`).value =
    "Personal Relief, Insurance Relief and Post-Retirement Medical Fund Relief are computed inside the monthly grid above (columns M–O).";
  ws.getCell(`A${row}`).font = { size: 8, italic: true };
  ws.mergeCells(`A${row}:G${row}`);
  return row + 1;
}

function writeFootnote(ws: any, startRow: number, spec: any, template: CertificateTemplate): number {
  let row = sectionLabel(ws, startRow, "STATUTORY NOTICE");
  const text = (spec?.body && String(spec.body).trim()) ||
    (template.body?.footer_note && String(template.body.footer_note).trim()) ||
    "";
  if (text) {
    ws.getCell(`A${row}`).value = text;
    ws.getCell(`A${row}`).font = { size: 8, color: { argb: "FF555A66" } };
    ws.getCell(`A${row}`).alignment = { wrapText: true, vertical: "top" };
    ws.mergeCells(`A${row}:G${row}`);
    ws.getRow(row).height = Math.min(120, 14 + Math.floor(text.length / 90) * 12);
    row += 1;
  }
  return row;
}

function writeSignatureBlock(ws: any, startRow: number): number {
  let row = sectionLabel(ws, startRow, "SIGNATURES");
  row += 2;
  ws.getCell(`A${row}`).value = "Prepared by:";
  ws.getCell(`A${row}`).font = { size: 8, color: { argb: "FF666B78" } };
  ws.getCell(`D${row}`).value = "Employer signature / stamp:";
  ws.getCell(`D${row}`).font = { size: 8, color: { argb: "FF666B78" } };
  row += 3;
  ws.getCell(`A${row}`).border = { top: { style: "thin", color: { argb: "FF555A66" } } };
  ws.mergeCells(`A${row}:C${row}`);
  ws.getCell(`D${row}`).border = { top: { style: "thin", color: { argb: "FF555A66" } } };
  ws.mergeCells(`D${row}:G${row}`);
  return row + 1;
}
