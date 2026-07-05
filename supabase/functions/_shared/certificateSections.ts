// @ts-nocheck — Deno runtime
/**
 * certificateSections — declarative renderer for the `body.sections[]`
 * shape used by per-employee tax certificates (KE P9, equivalents in
 * other localization packs). Country-agnostic: every layout decision
 * comes from the pack template row.
 *
 * Supported section types:
 *   - employee_header   → identity rows in the PDF summary band
 *   - monthly_breakdown → 12-row month grid columns
 *   - totals            → YTD totals band
 *
 * Out of scope: PDF emission — caller composes the ReportPdfPayload.
 */
import type { ReportPdfPayload } from "./reportPdfGenerator.ts";

export interface CertificateSection {
  type: string;
  title?: string;
  include?: string[];
  rule_codes?: string[];
  columns?: string[];
}

export interface MonthlyRow {
  month_index: number;
  rule_code: string;
  category: string | null;
  employee_amount: number;
  employer_amount: number;
  taxable_amount: number;
}

export interface SectionRenderContext {
  employee: Record<string, unknown>;
  ytdRows: Array<{
    rule_code: string;
    category: string | null;
    employee_amount: number;
    employer_amount: number;
    taxable_amount: number;
  }>;
  monthly: MonthlyRow[];
  totals: { employee: number; employer: number; taxable: number };
  currency: string;
  fiscalYear: number;
}

function money(n: number, currency = "") {
  const s = (Number(n) || 0).toFixed(2);
  return currency ? `${currency} ${s}` : s;
}

const MONTH_LABELS = [
  "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec",
];

export interface RenderedSections {
  headerRows: Array<{ label: string; value: string }>;
  monthlyTable: null | {
    columns: ReportPdfPayload["columns"];
    rows: Array<Record<string, unknown>>;
    title: string;
  };
  totalsRows: Array<{ label: string; value: string }>;
}

/**
 * Project pack-template sections into PDF-engine primitives.
 * Returns empty arrays when `sections` is missing/empty — caller can
 * fall back to the legacy `blocks`-based renderer.
 */
export function renderCertificateSections(
  sections: unknown,
  ctx: SectionRenderContext,
): RenderedSections {
  const out: RenderedSections = {
    headerRows: [],
    monthlyTable: null,
    totalsRows: [],
  };
  if (!Array.isArray(sections) || sections.length === 0) return out;

  for (const raw of sections as CertificateSection[]) {
    const type = String(raw?.type ?? "").trim();
    if (!type) continue;

    if (type === "employee_header") {
      const wanted = Array.isArray(raw.include) && raw.include.length
        ? raw.include
        : ["employee_number","tax_pin","national_id","position","department"];
      for (const key of wanted) {
        const v = (ctx.employee as any)[key];
        if (v === undefined || v === null || v === "") continue;
        out.headerRows.push({
          label: humanize(key),
          value: String(v),
        });
      }
      continue;
    }

    if (type === "monthly_breakdown") {
      const ruleCodes = Array.isArray(raw.rule_codes) ? raw.rule_codes : [];
      const cols = Array.isArray(raw.columns) && raw.columns.length
        ? raw.columns
        : ruleCodes;
      // Pivot: rows = month 1..12, columns = each rule_code (employee_amount)
      const pivot = new Map<number, Record<string, number>>();
      for (let m = 1; m <= 12; m++) pivot.set(m, {});
      for (const row of ctx.monthly) {
        if (ruleCodes.length && !ruleCodes.includes(row.rule_code)) continue;
        const bucket = pivot.get(row.month_index);
        if (!bucket) continue;
        bucket[row.rule_code] = (bucket[row.rule_code] ?? 0) + Number(row.employee_amount || 0);
      }
      const tableColumns: ReportPdfPayload["columns"] = [
        { key: "month", header: "Month", align: "left" },
        ...cols.map((c) => ({
          key: c,
          header: humanize(c),
          align: "right" as const,
          format: "money" as const,
        })),
      ];
      const tableRows: Array<Record<string, unknown>> = [];
      for (let m = 1; m <= 12; m++) {
        const bucket = pivot.get(m) ?? {};
        const r: Record<string, unknown> = { month: MONTH_LABELS[m - 1] };
        for (const c of cols) r[c] = Number(bucket[c] ?? 0);
        tableRows.push(r);
      }
      // Totals row
      const totalRow: Record<string, unknown> = { month: "Total" };
      for (const c of cols) {
        totalRow[c] = tableRows.reduce((a, r) => a + (Number((r as any)[c]) || 0), 0);
      }
      tableRows.push(totalRow);

      out.monthlyTable = {
        title: raw.title ?? "Monthly Breakdown",
        columns: tableColumns,
        rows: tableRows,
      };
      continue;
    }

    if (type === "totals") {
      out.totalsRows.push(
        { label: "Total employee deductions",  value: money(ctx.totals.employee, ctx.currency) },
        { label: "Total employer contributions", value: money(ctx.totals.employer, ctx.currency) },
        { label: "Total taxable income",        value: money(ctx.totals.taxable, ctx.currency) },
      );
      continue;
    }
    // Unknown section type — silently skip (forward-compat with new packs)
  }

  return out;
}

function humanize(key: unknown): string {
  const s = typeof key === "string"
    ? key
    : (key && typeof key === "object" && "key" in (key as any))
      ? String((key as any).key ?? "")
      : String(key ?? "");
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
