// @ts-nocheck — Deno runtime
/**
 * certificateSections — declarative renderer for the `body.sections[]`
 * shape used by tax certificates (KE P9, Certificate of Service, and
 * equivalents in other localization packs). Country-agnostic: every
 * layout decision comes from the pack template row.
 *
 * Supported section types (kept in sync with the certificate_template_v2
 * JSON Schema seeded in migration 20260706 — ADR 0060):
 *   - employer_header       → employer identity band (name, PIN, address, tax office)
 *   - employee_header       → employee identity band
 *   - fiscal_period_band    → fiscal year / period-of-service band
 *   - monthly_breakdown     → 12-row month grid
 *   - ytd_table             → generic YTD earnings-and-deductions table (legacy)
 *   - totals                → YTD totals band
 *   - relief_summary        → statutory relief summary (personal, insurance)
 *   - signature_block       → preparer/employer signature band
 *   - statutory_footnote    → legal notice printed under the tables
 *
 * Out of scope: PDF emission — caller composes the ReportPdfPayload.
 */
import type { ReportPdfPayload } from "./reportPdfGenerator.ts";

export interface CertificateSection {
  type: string;
  title?: string;
  include?: string[];
  rule_codes?: string[];
  columns?: any[];
  body?: string;
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
  employer?: Record<string, unknown>;
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
  periodLabel?: string;
}

function money(n: number, currency = "") {
  const s = (Number(n) || 0).toFixed(2);
  return currency ? `${currency} ${s}` : s;
}

const MONTH_LABELS = [
  "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec",
];

export interface RenderedSections {
  employerRows: Array<{ label: string; value: string }>;
  headerRows: Array<{ label: string; value: string }>;
  periodRows: Array<{ label: string; value: string }>;
  reliefRows: Array<{ label: string; value: string }>;
  monthlyTable: null | {
    columns: ReportPdfPayload["columns"];
    rows: Array<Record<string, unknown>>;
    title: string;
  };
  ytdTable: null | {
    columns: ReportPdfPayload["columns"];
    rows: Array<Record<string, unknown>>;
    title: string;
  };
  totalsRows: Array<{ label: string; value: string }>;
  signatureRows: Array<{ label: string; value: string }>;
  footnotes: string[];
}

/**
 * Project pack-template sections into PDF-engine primitives.
 * Empty arrays when `sections` is missing/empty — caller can fall back
 * to the legacy `blocks`-based renderer.
 */
export function renderCertificateSections(
  sections: unknown,
  ctx: SectionRenderContext,
): RenderedSections {
  const out: RenderedSections = {
    employerRows: [],
    headerRows: [],
    periodRows: [],
    reliefRows: [],
    monthlyTable: null,
    ytdTable: null,
    totalsRows: [],
    signatureRows: [],
    footnotes: [],
  };
  if (!Array.isArray(sections) || sections.length === 0) return out;

  for (const raw of sections as CertificateSection[]) {
    const type = String(raw?.type ?? "").trim();
    if (!type) continue;

    if (type === "employer_header") {
      const wanted = Array.isArray(raw.include) && raw.include.length
        ? raw.include
        : ["name","tax_pin","address"];
      for (const key of wanted) {
        const v = (ctx.employer ?? {} as any)[key];
        if (v === undefined || v === null || v === "") continue;
        out.employerRows.push({ label: humanize(key), value: String(v) });
      }
      continue;
    }

    if (type === "employee_header") {
      const wanted = Array.isArray(raw.include) && raw.include.length
        ? raw.include
        : ["employee_number","tax_pin","national_id","position","department"];
      for (const key of wanted) {
        const v = (ctx.employee as any)[key];
        if (v === undefined || v === null || v === "") continue;
        out.headerRows.push({ label: humanize(key), value: String(v) });
      }
      continue;
    }

    if (type === "fiscal_period_band") {
      out.periodRows.push({
        label: raw.title ?? "Fiscal Year",
        value: ctx.periodLabel ?? String(ctx.fiscalYear),
      });
      continue;
    }

    if (type === "monthly_breakdown") {
      const ruleCodes = Array.isArray(raw.rule_codes) ? raw.rule_codes : [];
      const cols = Array.isArray(raw.columns) && raw.columns.length
        ? raw.columns
        : ruleCodes;
      const pivot = new Map<number, Record<string, number>>();
      for (let m = 1; m <= 12; m++) pivot.set(m, {});
      for (const row of ctx.monthly) {
        if (ruleCodes.length && !ruleCodes.includes(row.rule_code)) continue;
        const bucket = pivot.get(row.month_index);
        if (!bucket) continue;
        bucket[row.rule_code] = (bucket[row.rule_code] ?? 0) + Number(row.employee_amount || 0);
      }
      const colKeys: string[] = cols.map((c: any) =>
        typeof c === "string" ? c : String(c?.key ?? c?.code ?? c?.rule_code ?? "")
      ).filter(Boolean);
      const headerFor = (c: any, fallback: string) =>
        (c && typeof c === "object" && typeof c.header === "string" && c.header) || humanize(fallback);
      const tableColumns: ReportPdfPayload["columns"] = [
        { key: "month", header: "Month", align: "left" },
        ...cols.map((c: any, i: number) => ({
          key: colKeys[i],
          header: headerFor(c, colKeys[i]),
          align: "right" as const,
          format: "money" as const,
        })).filter((c: any) => !!c.key),
      ];
      const tableRows: Array<Record<string, unknown>> = [];
      for (let m = 1; m <= 12; m++) {
        const bucket = pivot.get(m) ?? {};
        const r: Record<string, unknown> = { month: MONTH_LABELS[m - 1] };
        for (const c of colKeys) r[c] = Number(bucket[c] ?? 0);
        tableRows.push(r);
      }
      const totalRow: Record<string, unknown> = { month: "Total" };
      for (const c of colKeys) {
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

    if (type === "ytd_table") {
      const cols = Array.isArray(raw.columns) && raw.columns.length
        ? raw.columns
        : ["rule_code","category","employee_amount","employer_amount","taxable_amount"];
      const colKeys: string[] = cols.map((c: any) =>
        typeof c === "string" ? c : String(c?.key ?? ""));
      out.ytdTable = {
        title: raw.title ?? "Earnings & Deductions",
        columns: colKeys.map((k) => ({
          key: k,
          header: humanize(k),
          align: (k.endsWith("_amount") ? "right" : "left") as any,
          format: k.endsWith("_amount") ? "money" as const : undefined,
        })),
        rows: ctx.ytdRows.map((r) => {
          const o: Record<string, unknown> = {};
          for (const k of colKeys) o[k] = (r as any)[k] ?? "";
          return o;
        }),
      };
      continue;
    }

    if (type === "totals") {
      out.totalsRows.push(
        { label: "Total employee deductions",   value: money(ctx.totals.employee, ctx.currency) },
        { label: "Total employer contributions", value: money(ctx.totals.employer, ctx.currency) },
        { label: "Total taxable income",         value: money(ctx.totals.taxable, ctx.currency) },
      );
      continue;
    }

    if (type === "relief_summary") {
      const findYtd = (code: string) => ctx.ytdRows.find((r) => r.rule_code === code);
      const codes = Array.isArray(raw.rule_codes) && raw.rule_codes.length
        ? raw.rule_codes
        : ["personal_relief","insurance_relief"];
      for (const code of codes) {
        const row = findYtd(code);
        if (!row) continue;
        out.reliefRows.push({
          label: humanize(code),
          value: money(Number(row.employee_amount) || 0, ctx.currency),
        });
      }
      continue;
    }

    if (type === "signature_block") {
      const wanted = Array.isArray(raw.include) && raw.include.length
        ? raw.include
        : ["preparer","date","employer_stamp"];
      for (const key of wanted) {
        out.signatureRows.push({ label: humanize(key), value: "____________________" });
      }
      continue;
    }

    if (type === "statutory_footnote") {
      const text = String(raw.body ?? "").trim();
      if (text) out.footnotes.push(text);
      continue;
    }

    // Unknown section type — skip silently (forward-compat) BUT the
    // certificate_template_v2 JSON Schema (DB trigger) rejects unknown
    // types at publisher save time, so this branch is only reached by
    // legacy pre-v2 bodies flagged `legacy_unvalidated=true`.
  }

  return out;
}

function humanize(key: unknown): string {
  const s = typeof key === "string"
    ? key
    : (key && typeof key === "object" && "key" in (key as any))
      ? String((key as any).key ?? "")
      : String(key ?? "");
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
