/**
 * Wave 7.2 — Vendor statement snapshot builder.
 * Mirrors `supabase/functions/generate-document/index.ts::fetchVendorStatement`
 * for `document_kinds.code = 'purchases.statement'`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SnapshotBlob } from "./index";

export interface VendorStatementContactRow {
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

export interface VendorStatementBusinessRow {
  id: string;
  name?: string | null;
  base_currency?: string | null;
}

export interface VendorStatementHeaderRow {
  id: string;
  contact_id: string;
  vendor_id?: string | null;
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  period_start: string;
  period_end: string;
  statement_date: string | null;
  created_at: string;
  opening_balance: number | null;
  closing_balance: number | null;
  total_billed: number | null;
  total_payments: number | null;
  sent_at: string | null;
  contact: VendorStatementContactRow | null;
  business: VendorStatementBusinessRow | null;
}

export interface VendorStatementBillRow {
  bill_number: string | null;
  bill_date: string;
  total: number | null;
  amount_paid: number | null;
  status: string | null;
  vendor_invoice_number?: string | null;
}
export interface VendorStatementPaymentRow {
  reference: string | null;
  payment_date: string;
  amount: number | null;
}
export interface VendorStatementCreditNoteRow {
  credit_note_number: string | null;
  credit_date: string;
  total: number | null;
  status: string | null;
}

export interface VendorStatementTransactionOut {
  date: string;
  type: string;
  reference: string;
  description: string;
  charges: number;
  credits: number;
  balance: number;
}
export interface VendorStatementAgingBucketOut {
  label: string;
  amount: number;
}

export interface BuildVendorStatementSnapshotResult {
  snapshot: SnapshotBlob;
  documentNumber: string;
  documentDate: string;
  organizationId: string;
  businessId: string | null;
  branchId: string | null;
  currency: string;
  sourceDocId: string;
  vendorId: string | null;
}

export interface BuildVendorStatementInput {
  statement: VendorStatementHeaderRow;
  bills: VendorStatementBillRow[];
  payments: VendorStatementPaymentRow[];
  creditNotes: VendorStatementCreditNoteRow[];
  now?: Date;
}

export function buildVendorStatementSnapshot(
  input: BuildVendorStatementInput,
): BuildVendorStatementSnapshotResult {
  const { statement, bills, payments, creditNotes } = input;
  if (!statement.id) throw new Error("buildVendorStatementSnapshot: id required");
  if (!statement.period_start || !statement.period_end) {
    throw new Error("buildVendorStatementSnapshot: period_start / period_end required");
  }

  type Row = { date: string; type: string; ref: string; desc: string; debit: number; credit: number };
  const rows: Row[] = [];

  for (const bill of bills ?? []) {
    const refSuffix = bill.vendor_invoice_number ? ` (Ref: ${bill.vendor_invoice_number})` : "";
    rows.push({
      date: bill.bill_date,
      type: "Bill",
      ref: bill.bill_number || "",
      desc: `Bill ${bill.bill_number || ""}${refSuffix}`.trim(),
      debit: Number(bill.total) || 0,
      credit: 0,
    });
  }
  for (const pmt of payments ?? []) {
    rows.push({
      date: pmt.payment_date,
      type: "Payment",
      ref: pmt.reference || "—",
      desc: `Payment${pmt.reference ? ` (${pmt.reference})` : ""}`,
      debit: 0,
      credit: Number(pmt.amount) || 0,
    });
  }
  for (const cn of creditNotes ?? []) {
    rows.push({
      date: cn.credit_date,
      type: "Credit Note",
      ref: cn.credit_note_number || "",
      desc: `Vendor Credit ${cn.credit_note_number || ""}`.trim(),
      debit: 0,
      credit: Number(cn.total) || 0,
    });
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });

  let running = Number(statement.opening_balance) || 0;
  const statement_transactions: VendorStatementTransactionOut[] = rows.map((r) => {
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
  let current = 0, d30 = 0, d60 = 0, d90 = 0, dOver = 0;
  for (const bill of bills ?? []) {
    const bal = (Number(bill.total) || 0) - (Number(bill.amount_paid) || 0);
    if (bal <= 0) continue;
    const days = Math.floor(
      (now.getTime() - new Date(bill.bill_date).getTime()) / (1000 * 60 * 60 * 24),
    );
    if (days <= 0) current += bal;
    else if (days <= 30) d30 += bal;
    else if (days <= 60) d60 += bal;
    else if (days <= 90) d90 += bal;
    else dOver += bal;
  }
  const statement_aging: VendorStatementAgingBucketOut[] = [
    { label: "Current", amount: current },
    { label: "1-30 Days", amount: d30 },
    { label: "31-60 Days", amount: d60 },
    { label: "61-90 Days", amount: d90 },
    { label: "90+ Days", amount: dOver },
  ];

  const currency = statement.business?.base_currency || "USD";
  const closingBalance = statement.closing_balance ?? running;
  const documentNumber = `Vendor Statement - ${statement.contact?.name || "Vendor"}`;
  const issueDateIso = statement.statement_date || statement.created_at;

  const snapshot: SnapshotBlob = {
    document_number: documentNumber,
    document_type: "vendor_statement",
    document_type_label: "VENDOR STATEMENT",
    status: statement.sent_at ? "sent" : "draft",
    issue_date: issueDateIso,
    subtotal: Number(statement.total_billed) || 0,
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
    vendorId: statement.vendor_id ?? statement.contact_id ?? null,
  };
}

export async function fetchAndBuildVendorStatementSnapshot(
  supabase: SupabaseClient,
  statementId: string,
  opts?: { now?: Date },
): Promise<BuildVendorStatementSnapshotResult> {
  const { data: stmt, error } = await supabase
    .from("vendor_statements")
    .select(
      `
      id, contact_id, organization_id, business_id, branch_id,
      period_start, period_end, statement_date, created_at,
      opening_balance, closing_balance, total_billed, total_payments, sent_at,
      contact:contacts(name, email, phone, address_line1, city, state, postal_code, country, tax_id),
      business:businesses(id, name, base_currency)
      `,
    )
    .eq("id", statementId)
    .single();

  if (error || !stmt) {
    throw new Error(
      `fetchAndBuildVendorStatementSnapshot: statement ${statementId} not found: ${error?.message ?? "no row"}`,
    );
  }

  const s = stmt as unknown as VendorStatementHeaderRow;
  const vendorId = s.contact_id;

  const billQ = supabase
    .from("bills")
    .select("bill_number, bill_date, total, amount_paid, status, vendor_invoice_number")
    .eq("organization_id", s.organization_id)
    .eq("vendor_id", vendorId)
    .in("status", ["received", "paid", "partial", "overdue"])
    .gte("bill_date", s.period_start)
    .lte("bill_date", s.period_end)
    .order("bill_date");

  const allBillsQ = supabase
    .from("bills")
    .select("id")
    .eq("organization_id", s.organization_id)
    .eq("vendor_id", vendorId);

  const cnQ = supabase
    .from("vendor_credit_notes")
    .select("credit_note_number, credit_date, total, status")
    .eq("organization_id", s.organization_id)
    .eq("vendor_id", vendorId)
    .in("status", ["confirmed", "applied"])
    .gte("credit_date", s.period_start)
    .lte("credit_date", s.period_end)
    .order("credit_date");

  const [billRes, allBillRes, cnRes] = await Promise.all([
    s.business_id ? billQ.eq("business_id", s.business_id) : billQ,
    s.business_id ? allBillsQ.eq("business_id", s.business_id) : allBillsQ,
    s.business_id ? cnQ.eq("business_id", s.business_id) : cnQ,
  ]);

  if (billRes.error) throw new Error(`vendor statement bills: ${billRes.error.message}`);
  if (allBillRes.error) throw new Error(`vendor statement bill ids: ${allBillRes.error.message}`);
  if (cnRes.error) throw new Error(`vendor statement credit_notes: ${cnRes.error.message}`);

  const allBillIds = (allBillRes.data ?? []).map((b: { id: string }) => b.id);
  let payments: VendorStatementPaymentRow[] = [];
  if (allBillIds.length > 0) {
    const { data: pmts, error: pErr } = await supabase
      .from("bill_payments")
      .select("reference, payment_date, amount")
      .eq("organization_id", s.organization_id)
      .in("bill_id", allBillIds)
      .gte("payment_date", s.period_start)
      .lte("payment_date", s.period_end)
      .order("payment_date");
    if (pErr) throw new Error(`vendor statement bill_payments: ${pErr.message}`);
    payments = (pmts ?? []) as VendorStatementPaymentRow[];
  }

  return buildVendorStatementSnapshot({
    statement: s,
    bills: (billRes.data ?? []) as VendorStatementBillRow[],
    payments,
    creditNotes: (cnRes.data ?? []) as VendorStatementCreditNoteRow[],
    now: opts?.now,
  });
}
