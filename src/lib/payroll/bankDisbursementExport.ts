/**
 * Bank disbursement file export for payroll payment batches.
 *
 * Formats are pack-driven: every supported bank file is a row in
 * `localization_pack_bank_export_templates` with a JSONB `spec` describing
 * the column layout. The engine here is country-neutral — adding a new
 * country's bank rail is a data change (one row, optionally linked to a
 * localization pack), not a source edit.
 *
 * Pure functions only — no Supabase/DOM calls. Fetching lives in the
 * caller (see `usePayrollBankExport`), and the browser download glue lives
 * in `triggerCsvDownload` below.
 *
 * Currency policy: the engine is country-agnostic. Currency MUST resolve
 * from the row, the batch, or the source bank account. If none is
 * available we throw rather than silently defaulting — a wrong-currency
 * bank file is a compliance incident, not a UX glitch.
 */

import { supabase } from "@/integrations/supabase/client";
import { downloadCsv } from "@/lib/exports/csv";

/**
 * Free-form format code resolved at runtime from
 * `localization_pack_bank_export_templates.format_code`. Kept as `string`
 * so adding a new country's rail does not require a source change.
 */
export type BankExportFormat = string;

export interface BankExportTemplate {
  id: string;
  pack_id: string | null;
  format_code: string;
  display_name: string;
  country_code: string | null;
  file_extension: string;
  mime_type: string;
  builder_kind: "csv_columns" | "fixed_width" | "xml";
  spec: BankExportSpec;
}

interface BankExportColumn {
  header: string;
  /** Source key on `BankExportRow`, or a synthetic key handled below. */
  source: string;
  /** Optional format hint: e.g. "money2" → amount.toFixed(2). */
  format?: "money2";
  /** For `bank_code_split`: which side to emit. */
  part?: "bank" | "branch";
}

interface BankExportSpec {
  delimiter?: string;
  line_ending?: "CRLF" | "LF";
  include_header?: boolean;
  reference_template?: string;
  narration_template?: string;
  columns: BankExportColumn[];
}

export interface BankExportRow {
  employee_id: string;
  employee_number: string | null;
  first_name: string | null;
  last_name: string | null;
  bank_name: string | null;
  bank_branch: string | null;
  bank_code: string | null;
  bank_account_number: string | null;
  amount: number;
  currency: string;
  reference: string;
}

export interface BankExportBatch {
  batch_number: string;
  payment_date: string | null;
  total_amount: number;
  currency: string;
  source_bank_account?: {
    name?: string | null;
    bank_name?: string | null;
    account_number?: string | null;
  } | null;
}

/** RFC 4180 minimal-quote escape. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(
  headers: string[],
  rows: (string | number | null)[][],
  delimiter = ",",
  lineEnding: "CRLF" | "LF" = "CRLF",
  includeHeader = true,
): string {
  const sep = lineEnding === "LF" ? "\n" : "\r\n";
  const lines: string[] = [];
  if (includeHeader) lines.push(headers.map(csvCell).join(delimiter));
  for (const r of rows) lines.push(r.map(csvCell).join(delimiter));
  return lines.join(sep) + sep;
}

function requireCurrency(row: BankExportRow, batch: BankExportBatch): string {
  const currency = row.currency || batch.currency;
  if (!currency) {
    throw new Error(
      `Bank export: missing currency for batch '${batch.batch_number}' row '${row.employee_number ?? row.employee_id}'. ` +
      "Set the source bank account currency or the batch currency before exporting.",
    );
  }
  return currency;
}

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

/**
 * Resolve one column value for one row using the pack spec.
 * Unknown sources throw — silently emitting blanks is how compliance
 * incidents start.
 */
function resolveColumn(
  col: BankExportColumn,
  row: BankExportRow,
  batch: BankExportBatch,
  spec: BankExportSpec,
): string {
  const refTpl = spec.reference_template ?? "{batch_number}-{employee_number}";
  const narrTpl = spec.narration_template ?? "Salary {payment_date}";
  const vars: Record<string, string> = {
    batch_number: batch.batch_number,
    payment_date: batch.payment_date ?? "",
    employee_number: row.employee_number ?? row.employee_id.slice(0, 8),
    first_name: row.first_name ?? "",
    last_name: row.last_name ?? "",
  };

  switch (col.source) {
    case "employee_number": return row.employee_number ?? "";
    case "first_name":      return row.first_name ?? "";
    case "last_name":       return row.last_name ?? "";
    case "full_name":       return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
    case "bank_name":       return row.bank_name ?? "";
    case "bank_branch":     return row.bank_branch ?? "";
    case "bank_code":       return row.bank_code ?? "";
    case "bank_account_number": return row.bank_account_number ?? "";
    case "currency":        return requireCurrency(row, batch);
    case "amount":          return col.format === "money2"
      ? row.amount.toFixed(2)
      : String(row.amount);
    case "reference_template": return fillTemplate(refTpl, vars).trim();
    case "narration_template": return fillTemplate(narrTpl, vars).trim();
    case "bank_code_split": {
      const [bank, branch] = splitBankCode(row.bank_code);
      return col.part === "branch" ? branch : bank;
    }
    default:
      throw new Error(
        `Bank export: column "${col.header}" references unknown source "${col.source}". ` +
        "Update the localization_pack_bank_export_templates row or extend resolveColumn.",
      );
  }
}

export function buildCsvFromTemplate(
  tpl: BankExportTemplate,
  batch: BankExportBatch,
  rows: BankExportRow[],
): string {
  if (tpl.builder_kind !== "csv_columns") {
    throw new Error(
      `Bank export: builder_kind "${tpl.builder_kind}" is not implemented yet (template ${tpl.format_code}).`,
    );
  }
  const spec = tpl.spec;
  if (!spec?.columns?.length) {
    throw new Error(`Bank export: template "${tpl.format_code}" has no columns configured.`);
  }
  const headers = spec.columns.map((c) => c.header);
  const body = rows.map((r) => spec.columns.map((c) => resolveColumn(c, r, batch, spec)));
  return toCsv(
    headers,
    body,
    spec.delimiter ?? ",",
    spec.line_ending ?? "CRLF",
    spec.include_header ?? true,
  );
}

export async function fetchBankExportTemplate(formatCode: string): Promise<BankExportTemplate> {
  const { data, error } = await supabase
    .from("localization_pack_bank_export_templates")
    .select("id, pack_id, format_code, display_name, country_code, file_extension, mime_type, builder_kind, spec")
    .eq("format_code", formatCode)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(
      `Bank export: no active template found for format "${formatCode}". ` +
      "Install the localization pack that provides this rail, or seed it in localization_pack_bank_export_templates.",
    );
  }
  return data as unknown as BankExportTemplate;
}

export async function listBankExportTemplates(): Promise<BankExportTemplate[]> {
  const { data, error } = await supabase
    .from("localization_pack_bank_export_templates")
    .select("id, pack_id, format_code, display_name, country_code, file_extension, mime_type, builder_kind, spec")
    .eq("is_active", true)
    .order("display_name");
  if (error) throw error;
  return (data ?? []) as unknown as BankExportTemplate[];
}

/**
 * Many ERPs store the combined bank+branch code as "BBB-BBBB" or "BBBBBBB".
 * Pesalink wants them split. If only one segment is present we assume it's
 * the bank code and leave branch blank (treasurer can fix per-row).
 */
function splitBankCode(code: string | null): [string, string] {
  if (!code) return ["", ""];
  if (code.includes("-")) {
    const [a, b] = code.split("-", 2);
    return [a.trim(), (b ?? "").trim()];
  }
  if (code.length > 3) return [code.slice(0, 2), code.slice(2)];
  return [code, ""];
}

/**
 * Pull the rows needed to build either CSV from the live tables.
 * Joins `payroll_payment_batch_items` → `employees` for bank metadata.
 */
export async function fetchBankExportRows(batchId: string): Promise<{
  batch: BankExportBatch;
  rows: BankExportRow[];
  missingBank: BankExportRow[];
}> {
  // `sel` keeps the select strings out of supabase-js' type-level parser
  // (deep-instantiation blowups); shapes are pinned by the casts below.
  const sel = (s: string): string => s;

  const { data: batch, error: bErr } = await supabase
    .from("payroll_payment_batches")
    .select(
      sel(
        "id, batch_number, payment_date, total_amount, bank_account:bank_accounts(name, bank_name, account_number, currency)"
      )
    )
    .eq("id", batchId)
    .single();
  if (bErr) throw bErr;

  const { data: items, error: iErr } = await supabase
    .from("payroll_payment_batch_items")
    .select(
      sel(
        "employee_id, amount, payment_reference, employee:employees(employee_number, first_name, last_name, bank_name, bank_branch, bank_code, bank_account_number)"
      )
    )
    .eq("batch_id", batchId);
  if (iErr) throw iErr;

  const currency = (batch as any)?.bank_account?.currency ?? null;
  if (!currency) {
    throw new Error(
      `Bank export: source bank account for batch '${(batch as any).batch_number}' has no currency configured. ` +
      "Set the bank account currency before exporting.",
    );
  }

  const rows: BankExportRow[] = (items ?? []).map((it: any) => ({
    employee_id: it.employee_id,
    employee_number: it.employee?.employee_number ?? null,
    first_name: it.employee?.first_name ?? null,
    last_name: it.employee?.last_name ?? null,
    bank_name: it.employee?.bank_name ?? null,
    bank_branch: it.employee?.bank_branch ?? null,
    bank_code: it.employee?.bank_code ?? null,
    bank_account_number: it.employee?.bank_account_number ?? null,
    amount: Number(it.amount || 0),
    currency,
    reference: it.payment_reference ?? "",
  }));

  const missingBank = rows.filter((r) => !r.bank_account_number);

  return {
    batch: {
      batch_number: (batch as any).batch_number,
      payment_date: (batch as any).payment_date,
      total_amount: Number((batch as any).total_amount || 0),
      currency,
      source_bank_account: (batch as any).bank_account ?? null,
    },
    rows,
    missingBank,
  };
}

/** Browser-only: trigger a CSV download via the canonical writer (UTF-8 BOM + CRLF, Excel-safe). */
export function triggerCsvDownload(filename: string, csv: string) {
  downloadCsv(filename, csv);
}

async function sha256Hex(input: string): Promise<string | null> {
  try {
    const enc = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

/**
 * Generate a bank file, register it under `payroll_bank_export_files`
 * (status='generated'), trigger the browser download, and mark the batch
 * `exported` via the lifecycle RPC. The DB unique index on
 * `(batch_id) WHERE status NOT IN ('cancelled','rejected')` prevents
 * accidental double-generation; callers must cancel the prior file first.
 */
export async function exportBatchToBankFile(batchId: string, formatCode: string) {
  const [tpl, fetched] = await Promise.all([
    fetchBankExportTemplate(formatCode),
    fetchBankExportRows(batchId),
  ]);
  const { batch, rows, missingBank } = fetched;
  if (rows.length === 0) throw new Error("Batch has no items to export");
  const csv = buildCsvFromTemplate(tpl, batch, rows);
  const fileName = `${batch.batch_number}-${tpl.format_code}.${tpl.file_extension}`;
  const checksum = await sha256Hex(csv);

  // Load org/business off the batch (RLS-restricted SELECT — OK from client)
  const { data: batchRow, error: brErr } = await supabase
    .from("payroll_payment_batches")
    .select("organization_id, business_id")
    .eq("id", batchId)
    .single();
  if (brErr) throw brErr;

  // Idempotency: skip insert if an active file already exists for this batch.
  const { data: existing } = await supabase
    .from("payroll_bank_export_files" as any)
    .select("id, status")
    .eq("batch_id", batchId)
    .not("status", "in", "(cancelled,rejected)")
    .maybeSingle();

  let fileId: string | null = (existing as any)?.id ?? null;
  if (!fileId) {
    const { data: ins, error: insErr } = await supabase
      .from("payroll_bank_export_files" as any)
      .insert({
        organization_id: (batchRow as any).organization_id,
        business_id: (batchRow as any).business_id,
        batch_id: batchId,
        template_id: (tpl as any).id ?? null,
        format_code: tpl.format_code,
        file_name: fileName,
        checksum_sha256: checksum,
        line_count: rows.length,
        total_amount: rows.reduce((s, r) => s + Number(r.amount || 0), 0),
        currency_code: batch.currency ?? null,
        status: "generated",
      } as any)
      .select("id")
      .single();
    if (insErr) throw insErr;
    fileId = (ins as any).id;
  }

  // Roll the batch into `exported` via the lifecycle RPC (SoD-guarded).
  // Non-fatal: if the batch is in a non-eligible state, surface a warning
  // but still hand the user the file they generated.
  const { error: rpcErr } = await supabase.rpc(
    "payroll_payment_batch_mark_exported" as any,
    { p_batch_id: batchId, p_template_code: tpl.format_code } as any,
  );

  triggerCsvDownload(fileName, csv);

  return {
    rowCount: rows.length,
    missingBankCount: missingBank.length,
    template: tpl,
    fileId,
    lifecycleWarning: rpcErr ? rpcErr.message : null,
  };
}
