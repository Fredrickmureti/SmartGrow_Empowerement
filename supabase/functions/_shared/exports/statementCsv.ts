/**
 * Milestone C.1 — Tabular exports through the platform.
 *
 * CSV serialiser for `customer_statement` / `vendor_statement` document
 * data. Consumes the SAME `DocumentData` produced by the statement
 * fetchers in `generate-document/index.ts`, so byte-identity is
 * guaranteed against whatever the statement PDF renderer sees.
 *
 * Emits RFC 4180 compliant text (CRLF row separator, `"` escaping, BOM
 * prepended so Excel / Numbers auto-detect UTF-8) and returns a
 * `Uint8Array` for the persistence pipeline.
 */
import type { DocumentData } from "../templateRenderer.ts";

const CRLF = "\r\n";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "number" ? String(value) : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

export function buildStatementCsv(doc: DocumentData): Uint8Array {
  const currency = doc.currency ?? "USD";
  const lines: string[] = [];

  // Masthead (2-column key/value pairs — friendly for spreadsheet open).
  lines.push(csvRow([doc.document_type_label ?? "STATEMENT"]));
  lines.push(csvRow(["Company", doc.organization?.name ?? ""]));
  lines.push(csvRow(["Contact", doc.contact?.name ?? ""]));
  lines.push(csvRow(["Statement date", doc.issue_date ?? ""]));
  lines.push(csvRow(["Period start", (doc as any).statement_period_start ?? ""]));
  lines.push(csvRow(["Period end", (doc as any).statement_period_end ?? ""]));
  lines.push(csvRow(["Currency", currency]));
  lines.push(csvRow(["Opening balance", (doc as any).statement_opening_balance ?? 0]));
  lines.push(csvRow(["Closing balance", (doc as any).statement_closing_balance ?? doc.total ?? 0]));
  lines.push("");

  // Transactions table.
  lines.push(csvRow(["Date", "Type", "Reference", "Description", "Charges", "Credits", "Balance"]));
  const txns = ((doc as any).statement_transactions ?? []) as Array<{
    date: string;
    type: string;
    reference: string;
    description: string;
    charges: number;
    credits: number;
    balance: number;
  }>;
  for (const t of txns) {
    lines.push(csvRow([t.date, t.type, t.reference, t.description, t.charges, t.credits, t.balance]));
  }
  lines.push("");

  // Aging summary.
  lines.push(csvRow(["Aging bucket", "Amount"]));
  const aging = ((doc as any).statement_aging ?? []) as Array<{ label: string; amount: number }>;
  for (const a of aging) {
    lines.push(csvRow([a.label, a.amount]));
  }

  const body = "\uFEFF" + lines.join(CRLF) + CRLF;
  return new TextEncoder().encode(body);
}
