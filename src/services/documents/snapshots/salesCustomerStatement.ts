/**
 * Wave 7.2 · Step 6 — Customer statement snapshot builder.
 *
 * Mirrors `supabase/functions/generate-document/index.ts::fetchCustomerStatement`
 * (`document_kinds.code = 'sales.statement'`). A statement is not a
 * fiscal document — it summarizes invoices, payments, and credit notes
 * for a customer over a period. The renderer reads:
 *   - `statement_transactions[]` — sorted ledger with running balance
 *   - `statement_aging[]` — five-bucket aging summary
 *   - `statement_opening_balance` / `statement_closing_balance`
 *   - `statement_period_start` / `statement_period_end`
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export interface StatementContactRow {
  name: string | null;
  email?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  tax_id?: string | null;
}

export interface StatementBusinessRow {
  id: string;
  name?: string | null;
  base_currency?: string | null;
}

export interface StatementHeaderRow {
  id: string;
  contact_id: string;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  period_start: string;
  period_end: string;
  statement_date: string | null;
  created_at: string;
  opening_balance: number | null;
  closing_balance: number | null;
  total_invoiced: number | null;
  total_payments: number | null;
  sent_at: string | null;
  contact: StatementContactRow | null;
  business: StatementBusinessRow | null;
}

export interface StatementInvoiceRow {
  invoice_number: string | null;
  issue_date: string;
  total: number | null;
  amount_paid: number | null;
  status: string | null;
}
export interface StatementPaymentRow {
  receipt_number: string | null;
  payment_date: string;
  amount: number | null;
  payment_method?: string | null;
}
export interface StatementCreditNoteRow {
  credit_note_number: string | null;
  issue_date: string;
  total: number | null;
  status: string | null;
}

export interface StatementTransactionOut {
  date: string;
  type: string;
  reference: string;
  description: string;
  charges: number;
  credits: number;
  balance: number;
}

export interface StatementAgingBucketOut {
  label: string;
  amount: number;
}

export interface BuildStatementSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
}

export interface BuildStatementInput {
  statement: StatementHeaderRow;
  invoices: StatementInvoiceRow[];
  payments: StatementPaymentRow[];
  creditNotes: StatementCreditNoteRow[];
  /**
   * Injectable clock for deterministic aging in tests. Aging buckets use
   * `now - issue_date`; passing a fixed instant keeps snapshots stable.
   */
  now?: Date;
}

/**
 * Pure builder. Deterministic given the same inputs (plus `now` for aging).
 */
export function buildCustomerStatementSnapshot(
  input: BuildStatementInput,
): BuildStatementSnapshotResult {
  const { statement, invoices, payments, creditNotes } = input;
  if (!statement.id) throw new Error("buildCustomerStatementSnapshot: id required");
  if (!statement.period_start || !statement.period_end) {
    throw new Error("buildCustomerStatementSnapshot: period_start / period_end required");
  }

  type Row = {
    date: string;
    type: string;
    ref: string;
    desc: string;
    debit: number;
    credit: number;
  };
  const rows: Row[] = [];

  for (const inv of invoices ?? []) {
    rows.push({
      date: inv.issue_date,
      type: "Invoice",
      ref: inv.invoice_number || "",
      desc: `Invoice ${inv.invoice_number || ""}`.trim(),
      debit: Number(inv.total) || 0,
      credit: 0,
    });
  }
  for (const pmt of payments ?? []) {
    rows.push({
      date: pmt.payment_date,
      type: "Payment",
      ref: pmt.receipt_number || "—",
      desc: `Payment received${
        pmt.receipt_number ? ` (${pmt.receipt_number})` : ""
      }`,
      debit: 0,
      credit: Number(pmt.amount) || 0,
    });
  }
  for (const cn of creditNotes ?? []) {
    rows.push({
      date: cn.issue_date,
      type: "Credit Note",
      ref: cn.credit_note_number || "",
      desc: `Credit Note ${cn.credit_note_number || ""}`.trim(),
      debit: 0,
      credit: Number(cn.total) || 0,
    });
  }

  // Stable sort — date first, then type / reference — so replays match.
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });

  let running = Number(statement.opening_balance) || 0;
  const statement_transactions: StatementTransactionOut[] = rows.map((r) => {
    running += r.debit - r.credit;
    return {
      date: r.date,
      type: r.type,
      reference: r.ref,
      description: r.desc,
      charges: r.debit,
      credits: r.credit,
      balance: running,
    };
  });

  const now = input.now ?? new Date();
  let current = 0,
    d30 = 0,
    d60 = 0,
    d90 = 0,
    dOver = 0;
  for (const inv of invoices ?? []) {
    const bal = (Number(inv.total) || 0) - (Number(inv.amount_paid) || 0);
    if (bal <= 0) continue;
    const days = Math.floor(
      (now.getTime() - new Date(inv.issue_date).getTime()) /
        (1000 * 60 * 60 * 24),
    );
    if (days <= 0) current += bal;
    else if (days <= 30) d30 += bal;
    else if (days <= 60) d60 += bal;
    else if (days <= 90) d90 += bal;
    else dOver += bal;
  }
  const statement_aging: StatementAgingBucketOut[] = [
    { label: "Current", amount: current },
    { label: "1-30 Days", amount: d30 },
    { label: "31-60 Days", amount: d60 },
    { label: "61-90 Days", amount: d90 },
    { label: "90+ Days", amount: dOver },
  ];

  const currency = statement.business?.base_currency || "USD";
  const closingBalance = statement.closing_balance ?? running;
  const documentNumber = `Statement - ${statement.contact?.name || "Customer"}`;
  const issueDateIso = statement.statement_date || statement.created_at;

  const snapshot: SnapshotBlob = {
    document_number: documentNumber,
    document_type: "customer_statement",
    document_type_label: "CUSTOMER STATEMENT",
    status: statement.sent_at ? "sent" : "draft",
    issue_date: issueDateIso,
    subtotal: Number(statement.total_invoiced) || 0,
    tax_amount: 0,
    discount_amount: 0,
    total: closingBalance,
    amount_paid: Number(statement.total_payments) || 0,
    currency,
    notes: null,
    terms: null,
    contact: statement.contact,
    business_id: statement.business_id,
    organization_id: statement.organization_id,
    branch_id: statement.branch_id,
    items: [],
    statement_transactions,
    statement_aging,
    statement_opening_balance: Number(statement.opening_balance) || 0,
    statement_closing_balance: closingBalance,
    statement_period_start: statement.period_start,
    statement_period_end: statement.period_end,
  };

  const documentDate = (issueDateIso || statement.period_end).slice(0, 10);

  return {
    snapshot,
    documentNumber,
    documentDate,
    organizationId: statement.organization_id,
    businessId: statement.business_id,
    branchId: statement.branch_id,
    currency,
    sourceDocId: statement.id,
  };
}

export async function fetchAndBuildCustomerStatementSnapshot(
  supabase: SupabaseClient,
  statementId: string,
  opts?: { now?: Date },
): Promise<BuildStatementSnapshotResult> {
  const { data: stmt, error } = await supabase
    .from("customer_statements")
    .select(
      `
      id, contact_id, organization_id, business_id, branch_id,
      period_start, period_end, statement_date, created_at,
      opening_balance, closing_balance, total_invoiced, total_payments, sent_at,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, country, tax_id),
      business:businesses(id, name, base_currency)
      `,
    )
    .eq("id", statementId)
    .single();

  if (error || !stmt) {
    throw new Error(
      `fetchAndBuildCustomerStatementSnapshot: statement ${statementId} not found: ${
        error?.message ?? "no row"
      }`,
    );
  }

  const s = stmt as unknown as StatementHeaderRow;

  // Same three queries, in parallel — reproduces the edge-function view.
  const invoiceQ = supabase
    .from("invoices")
    .select("invoice_number, issue_date, total, amount_paid, status")
    .eq("organization_id", s.organization_id)
    .eq("contact_id", s.contact_id)
    .gte("issue_date", s.period_start)
    .lte("issue_date", s.period_end)
    .order("issue_date");
  const paymentQ = supabase
    .from("payments")
    .select("receipt_number, payment_date, amount, payment_method")
    .eq("organization_id", s.organization_id)
    .eq("contact_id", s.contact_id)
    .gte("payment_date", s.period_start)
    .lte("payment_date", s.period_end)
    .order("payment_date");
  const cnQ = supabase
    .from("credit_notes")
    .select("credit_note_number, issue_date, total, status")
    .eq("organization_id", s.organization_id)
    .eq("contact_id", s.contact_id)
    .gte("issue_date", s.period_start)
    .lte("issue_date", s.period_end)
    .in("status", ["issued", "applied", "partially_applied"])
    .order("issue_date");

  const [invRes, pmtRes, cnRes] = await Promise.all([
    s.business_id ? invoiceQ.eq("business_id", s.business_id) : invoiceQ,
    s.business_id ? paymentQ.eq("business_id", s.business_id) : paymentQ,
    s.business_id ? cnQ.eq("business_id", s.business_id) : cnQ,
  ]);

  if (invRes.error) throw new Error(`statement invoices: ${invRes.error.message}`);
  if (pmtRes.error) throw new Error(`statement payments: ${pmtRes.error.message}`);
  if (cnRes.error) throw new Error(`statement credit_notes: ${cnRes.error.message}`);

  return buildCustomerStatementSnapshot({
    statement: s,
    invoices: (invRes.data ?? []) as StatementInvoiceRow[],
    payments: (pmtRes.data ?? []) as StatementPaymentRow[],
    creditNotes: (cnRes.data ?? []) as StatementCreditNoteRow[],
    now: opts?.now,
  });
}