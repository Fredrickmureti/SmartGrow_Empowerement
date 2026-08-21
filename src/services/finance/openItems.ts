/**
 * Canonical AR / AP open-item access.
 *
 * ADR: `finance_ar_open_items` / `finance_ap_open_items_as_of` are the ONLY source
 * of receivable / payable figures. They are GL-gated projections — a document
 * only appears once a posted journal entry exists on the AR/AP control
 * account. Sales/purchase document status (`invoices.status`, `bills.status`)
 * is an operational fact about the document pipeline and MUST NOT be used to
 * compute receivables, payables, ageing, or expected cash.
 */

import { supabase } from "@/integrations/supabase/client";
import {
  addToAgingBuckets,
  daysOverdueFrom,
  emptyAgingBuckets,
  EMPTY_AGING_BUCKETS,
  type AgingBuckets,
} from "./aging";

/** @deprecated Use `AgingBuckets` / `EMPTY_AGING_BUCKETS` from `./aging`. */
export type OpenItemAging = AgingBuckets;
export const EMPTY_OPEN_ITEM_AGING: AgingBuckets = EMPTY_AGING_BUCKETS;


export interface OpenItemsSummary {
  openDocumentCount: number;
  totalResidual: number;
  notDue: number;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  overdueCount: number;
  /** Non-draft documents with no posted journal entry — an integrity gap, not a receivable. */
  unpostedDocumentCount: number;
  unpostedAmount: number;
}

export const EMPTY_OPEN_ITEMS_SUMMARY: OpenItemsSummary = {
  openDocumentCount: 0,
  totalResidual: 0,
  notDue: 0,
  current: 0,
  days30: 0,
  days60: 0,
  days90: 0,
  overdueCount: 0,
  unpostedDocumentCount: 0,
  unpostedAmount: 0,
};

interface SummaryRow {
  open_document_count: number | null;
  total_residual: number | null;
  not_due: number | null;
  current_bucket: number | null;
  days30: number | null;
  days60: number | null;
  days90: number | null;
  overdue_count: number | null;
  unposted_document_count: number | null;
  unposted_amount: number | null;
}

function mapSummary(row: SummaryRow | undefined | null): OpenItemsSummary {
  if (!row) return EMPTY_OPEN_ITEMS_SUMMARY;
  return {
    openDocumentCount: Number(row.open_document_count) || 0,
    totalResidual: Number(row.total_residual) || 0,
    notDue: Number(row.not_due) || 0,
    current: Number(row.current_bucket) || 0,
    days30: Number(row.days30) || 0,
    days60: Number(row.days60) || 0,
    days90: Number(row.days90) || 0,
    overdueCount: Number(row.overdue_count) || 0,
    unpostedDocumentCount: Number(row.unposted_document_count) || 0,
    unpostedAmount: Number(row.unposted_amount) || 0,
  };
}

async function fetchSummary(
  fn: "get_ar_summary" | "get_ap_summary",
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
  asOf?: string,
): Promise<OpenItemsSummary> {
  const { data, error } = await supabase.rpc(fn as any, {
    _org_id: orgId,
    _business_id: businessId ?? null,
    _branch_id: branchId ?? null,
    _as_of: asOf ?? new Date().toISOString().slice(0, 10),
  } as any);
  if (error) throw error;
  const rows = (data || []) as unknown as SummaryRow[];
  return mapSummary(rows[0]);
}

export function fetchARSummary(
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
  asOf?: string,
): Promise<OpenItemsSummary> {
  return fetchSummary("get_ar_summary", orgId, businessId, branchId, asOf);
}

export function fetchAPSummary(
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
  asOf?: string,
): Promise<OpenItemsSummary> {
  return fetchSummary("get_ap_summary", orgId, businessId, branchId, asOf);
}

export interface OpenItemRow {
  documentId: string;
  documentNumber: string | null;
  contactId: string | null;
  contactName: string;
  documentDate: string;
  dueDate: string | null;
  residual: number;
  daysOverdue: number;
}


/** Row shape returned by a point-in-time open-items engine (AR and AP share it). */
export interface ApOpenItemAsOfRow {
  organization_id: string;
  business_id: string | null;
  branch_id: string | null;
  document_id: string;
  document_number: string | null;
  contact_id: string | null;
  document_date: string | null;
  due_date: string | null;
  document_total: number;
  paid_amount: number;
  credited_amount: number;
  residual_amount: number;
  currency: string | null;
  base_residual_amount: number;
  source_kind: "bill" | "invoice" | "journal";
  aging_bucket: string;
  days_past_due: number;
}

/** Receivables engine rows have the same shape as payables engine rows. */
export type ArOpenItemAsOfRow = ApOpenItemAsOfRow;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The ONE receivables read. `finance_ar_open_items_as_of` is the point-in-time
 * AR engine — the exact mirror of the payables engine: a receipt or credit note
 * counts only if it happened on or before `asOf`, and an invoice appears only
 * once its journal entry was posted by that date. The legacy
 * `finance_ar_open_items` view always answers "today" and is not a substitute.
 */
export async function fetchArOpenItemsAsOf(
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
  asOf?: string,
): Promise<ArOpenItemAsOfRow[]> {
  const { data, error } = await supabase.rpc("finance_ar_open_items_as_of" as never, {
    _org_id: orgId,
    _business_id: businessId ?? null,
    _branch_id: branchId ?? null,
    _as_of: asOf ?? today(),
  } as never);
  if (error) throw error;
  return (data ?? []) as unknown as ArOpenItemAsOfRow[];
}

/** Unapplied customer credit as of a date — the AR credit half of the engine. */
export async function fetchArCustomerCreditAsOf(
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
  asOf?: string,
): Promise<Array<{ contact_id: string | null; credit_amount: number; base_credit_amount: number | null }>> {
  const { data, error } = await supabase.rpc("finance_ar_customer_credit_as_of" as never, {
    _org_id: orgId,
    _business_id: businessId ?? null,
    _branch_id: branchId ?? null,
    _as_of: asOf ?? today(),
  } as never);
  if (error) throw error;
  // ADR 0136: `base_credit_amount` is NULL when the row's currency has no rate
  // on file. It is an absence, never the foreign amount.
  return (data ?? []) as unknown as Array<{
    contact_id: string | null;
    credit_amount: number;
    base_credit_amount: number | null;
  }>;
}


/**
 * The ONE payables read. `finance_ap_open_items_as_of` is the point-in-time AP
 * engine behind Aged Payables, `get_ap_summary` and the aging report: payments
 * and vendor credits count only if they happened on or before `asOf`, so any
 * surface reading it reproduces the same number for the same date. The legacy
 * "current position" view is not a substitute — it always answers "today".
 */
export async function fetchApOpenItemsAsOf(
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
  asOf?: string,
): Promise<ApOpenItemAsOfRow[]> {
  const { data, error } = await supabase.rpc("finance_ap_open_items_as_of" as never, {
    _org_id: orgId,
    _business_id: businessId ?? null,
    _branch_id: branchId ?? null,
    _as_of: asOf ?? today(),
  } as never);
  if (error) throw error;
  return (data ?? []) as unknown as ApOpenItemAsOfRow[];
}

/** Unapplied vendor credit as of a date — the AP credit half of the same engine. */
export async function fetchApVendorCreditAsOf(
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
  asOf?: string,
): Promise<Array<{ contact_id: string | null; credit_amount: number; base_credit_amount: number | null }>> {
  const { data, error } = await supabase.rpc("finance_ap_vendor_credit_as_of" as never, {
    _org_id: orgId,
    _business_id: businessId ?? null,
    _branch_id: branchId ?? null,
    _as_of: asOf ?? today(),
  } as never);
  if (error) throw error;
  return (data ?? []) as unknown as Array<{
    contact_id: string | null;
    credit_amount: number;
    base_credit_amount: number;
  }>;
}

/**
 * Top counterparties by NET open position.
 *
 * ADR: for AR this reads `finance_ar_net_position`, the server-side projection
 * that buckets by age and nets unapplied customer credit in one place. Bucket
 * boundaries and credit netting are accounting rules, so they live in SQL — an
 * app-side re-derivation is how the dashboard and the aging report drift apart.
 * AP reads the point-in-time engine and nets unapplied vendor credit from the
 * same engine, so it agrees with Aged Payables by construction.
 */

export async function fetchTopOpenCounterparties(
  side: "ar" | "ap",
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
  limit = 5,
): Promise<Array<{ name: string; amount: number; daysOverdue: number }>> {
  if (side === "ar") {
    let nq = supabase
      .from("finance_ar_net_position" as any)
      .select("contact_name, net_amount, max_days_overdue")
      .eq("organization_id", orgId)
      .gt("net_amount", 0.01)
      .order("net_amount", { ascending: false })
      .limit(limit);
    if (businessId) nq = nq.eq("business_id", businessId);
    if (branchId) nq = nq.eq("branch_id", branchId);
    const { data: net, error: netError } = await nq;
    if (netError) throw netError;
    return ((net || []) as any[]).map((r) => ({
      name: r.contact_name || "Unknown",
      amount: Number(r.net_amount) || 0,
      daysOverdue: Number(r.max_days_overdue) || 0,
    }));
  }

  const rows = await fetchApOpenItemsAsOf(orgId, businessId, branchId);
  const contactIds = Array.from(new Set(rows.map((r) => r.contact_id).filter(Boolean)));
  const names = new Map<string, string>();
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, name")
      .in("id", contactIds);
    for (const c of contacts || []) names.set(c.id, c.name);
  }

  const byContact = new Map<string, { name: string; amount: number; daysOverdue: number }>();
  for (const r of rows) {
    const key = r.contact_id || "unknown";
    const name = (r.contact_id && names.get(r.contact_id)) || "Unknown";
    // `days_past_due` is computed by the engine against the as-of date — the
    // browser never re-derives it from a clock.
    const daysOverdue = Number(r.days_past_due) || 0;
    const existing = byContact.get(key) || { name, amount: 0, daysOverdue: 0 };
    // Base currency: exposures across currencies may only be added up after
    // conversion (`base_residual_amount`), never as raw document amounts.
    existing.amount += Number(r.base_residual_amount ?? r.residual_amount) || 0;
    existing.daysOverdue = Math.max(existing.daysOverdue, daysOverdue);
    byContact.set(key, existing);
  }

  // Unapplied vendor credit is a real payable offset — net it per supplier so
  // this list agrees with `get_ap_summary` and the aged payables report.
  const vendorCredit = await fetchVendorCreditByContact(orgId, businessId);
  for (const [contactId, credit] of vendorCredit) {
    const existing = byContact.get(contactId);
    if (existing) existing.amount -= credit;
  }


  return Array.from(byContact.values())
    .filter((c) => c.amount > 0.01)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}


/**
 * Per-counterparty open-item aging.
 *
 * ADR: contact-level receivable / payable figures MUST come from
 * `finance_ar_open_items_as_of` / `finance_ap_open_items_as_of`, never from a
 * status list over `invoices` / `bills`. Residual there nets every settlement channel
 * (cash receipts and applied credit notes) and only counts documents with a
 * posted journal entry on the control account.
 *
 * Bucketing uses the shared `bucketForDaysOverdue` mirror of the SQL CASE, and
 * unapplied customer credit is netted in for AR so this figure agrees with the
 * aging report and the AR summary instead of overstating the receivable.
 */
export async function fetchContactOpenItemAging(
  side: "ar" | "ap",
  params: {
    orgId: string;
    /** One contact, or a commercial-partner family (consolidated statements). */
    contactId: string | string[];
    businessId?: string | null;
    branchId?: string | null;
    /**
     * Reporting date (YYYY-MM-DD). Aging is measured against this date, not
     * the browser clock — a statement for a closed period must age as of the
     * period end, otherwise the same statement re-renders differently
     * tomorrow. Defaults to today only for "live" surfaces that pass nothing.
     */
    asOf?: string;
  },
): Promise<AgingBuckets> {
  const contactIds = Array.isArray(params.contactId) ? params.contactId : [params.contactId];
  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);
  const asOfDate = new Date(`${asOf}T00:00:00Z`);

  let data: any[] | null = null;

  // Both sides are served by their point-in-time engine, the same source as
  // Aged Receivables / Aged Payables: settlements only count if they happened
  // on or before the as-of date, so a statement for a closed period reproduces
  // the aging that period actually had instead of today's residuals.
  const rows =
    side === "ap"
      ? await fetchApOpenItemsAsOf(params.orgId, params.businessId, params.branchId, asOf)
      : await fetchArOpenItemsAsOf(params.orgId, params.businessId, params.branchId, asOf);
  data = rows.filter((r) => r.contact_id && contactIds.includes(r.contact_id));

  const buckets = emptyAgingBuckets();
  for (const row of (data || []) as any[]) {
    // Aging is a summed figure, so it must use the base-currency residual.
    const residual = Number(row.base_residual_amount ?? row.residual_amount) || 0;
    if (residual <= 0.01) continue;
    addToAgingBuckets(
      buckets,
      residual,
      daysOverdueFrom(row.due_date || row.document_date, asOfDate),
    );
  }

  const credit =
    side === "ar"
      ? await fetchUnappliedCustomerCredit(params.orgId, params.businessId, contactIds, asOf)
      : await fetchUnappliedVendorCredit(params.orgId, params.businessId, contactIds, asOf);

  if (credit > 0.01) addToAgingBuckets(buckets, -credit, 0);

  return buckets;
}


/**
 * Unapplied customer credit (advance receipts / unapplied credit notes) for an
 * org, optionally narrowed to one contact. This is a genuine credit position on
 * the customer and reduces the net receivable.
 *
 * ADR: reads `finance_ar_customer_credit_as_of`, the single canonical
 * definition of unapplied credit as of a reporting date, replayed from the
 * append-only credit movements. `get_ar_summary` and
 * `get_ar_ap_aging_from_ledger` read the same function, so no consumer can
 * invent its own credit filter (e.g. forget the 0.01 floor, the currency
 * handling, or the as-of cut-off).
 */
export async function fetchUnappliedCustomerCredit(
  orgId: string,
  businessId?: string | null,
  contactId?: string | string[] | null,
  asOf?: string,
): Promise<number> {
  const wanted = Array.isArray(contactId) ? contactId : contactId ? [contactId] : null;
  if (wanted && wanted.length === 0) return 0;

  let rows: Array<{ contact_id: string | null; base_credit_amount: number }>;
  try {
    rows = await fetchArCustomerCreditAsOf(orgId, businessId, null, asOf);
  } catch {
    return 0;
  }

  let total = 0;
  for (const row of rows) {
    if (wanted && (!row.contact_id || !wanted.includes(row.contact_id))) continue;
    total += Number(row.base_credit_amount) || 0;
  }
  return total;
}

/**
 * Unapplied vendor credit (unapplied vendor credit notes / purchase returns)
 * for an org, optionally narrowed to one supplier, as of a reporting date.
 *
 * Reads `finance_ap_vendor_credit_as_of`, the single canonical definition of
 * unapplied vendor credit and the same one `get_ap_summary` and
 * `get_ap_aging_summary` consume — never
 * `vendor_credit_notes.total - amount_applied`.
 */
export async function fetchUnappliedVendorCredit(
  orgId: string,
  businessId?: string | null,
  contactId?: string | string[] | null,
  asOf?: string,
): Promise<number> {
  const byContact = await fetchVendorCreditByContact(orgId, businessId, contactId, asOf);
  let total = 0;
  for (const amount of byContact.values()) total += amount;
  return total;
}


/**
 * Unapplied vendor credit keyed by supplier contact id (base currency),
 * as of a reporting date. Reads `finance_ap_vendor_credit_as_of` — the same
 * credit half of the engine Aged Payables and `get_ap_summary` use.
 */
async function fetchVendorCreditByContact(
  orgId: string,
  businessId?: string | null,
  contactId?: string | string[] | null,
  asOf?: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = Array.isArray(contactId)
    ? contactId
    : contactId
      ? [contactId]
      : null;
  if (wanted && wanted.length === 0) return out;

  let rows: Array<{ contact_id: string | null; base_credit_amount: number }>;
  try {
    rows = await fetchApVendorCreditAsOf(orgId, businessId, null, asOf);
  } catch {
    return out;
  }

  for (const row of rows) {
    const key = row.contact_id;
    if (!key) continue;
    if (wanted && !wanted.includes(key)) continue;
    out.set(key, (out.get(key) || 0) + (Number(row.base_credit_amount) || 0));
  }
  return out;
}




export interface ReceivableCounterparty {
  contactId: string;
  contactName: string;
  netAmount: number;
  maxDaysOverdue: number;
}

/**
 * The set of customers who actually owe money right now.
 *
 * ADR: this is the ONLY sanctioned cohort for statement runs, dunning sweeps
 * and collection work lists. It reads `finance_ar_net_position`, so the cohort
 * is GL-gated, nets unapplied customer credit, and includes receivables that
 * originate from manual journals on the AR control account. A cohort derived
 * from `invoices.status` is wrong in both directions: it invents debt for
 * unposted documents and hides debt that never came from an invoice.
 */
export async function fetchReceivableCounterparties(
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
): Promise<ReceivableCounterparty[]> {
  let q = supabase
    .from("finance_ar_net_position" as any)
    .select("contact_id, contact_name, net_amount, max_days_overdue")
    .eq("organization_id", orgId)
    .gt("net_amount", 0.01)
    .order("net_amount", { ascending: false });
  if (businessId) q = q.eq("business_id", businessId);
  if (branchId) q = q.eq("branch_id", branchId);

  const { data, error } = await q;
  if (error) throw error;

  const byContact = new Map<string, ReceivableCounterparty>();
  for (const r of (data || []) as any[]) {
    if (!r.contact_id) continue;
    const existing = byContact.get(r.contact_id);
    const netAmount = Number(r.net_amount) || 0;
    const maxDaysOverdue = Number(r.max_days_overdue) || 0;
    if (existing) {
      existing.netAmount += netAmount;
      existing.maxDaysOverdue = Math.max(existing.maxDaysOverdue, maxDaysOverdue);
    } else {
      byContact.set(r.contact_id, {
        contactId: r.contact_id,
        contactName: r.contact_name || "Unknown",
        netAmount,
        maxDaysOverdue,
      });
    }
  }
  return Array.from(byContact.values()).sort((a, b) => b.netAmount - a.netAmount);
}

export interface CurrencyNetPositionRow {
  contactId: string;
  contactName: string;
  currency: string;
  openDocumentCount: number;
  openAmount: number;
  creditAmount: number;
  netAmount: number;
  baseNetAmount: number;
  notDue: number;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  maxDaysOverdue: number;
}

/**
 * Per-currency net AR position per customer.
 *
 * ADR: reads `finance_ar_net_position_by_currency`, the server-side projection
 * that buckets by age AND currency. Aging buckets are in document currency so
 * a collector sees what the customer owes in their own currency. base_net_amount
 * is the base-currency equivalent for cross-currency totals.
 */
export async function fetchNetPositionByCurrency(
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
): Promise<CurrencyNetPositionRow[]> {
  let q = supabase
    .from("finance_ar_net_position_by_currency" as any)
    .select(
      "contact_id, contact_name, currency, open_document_count, open_amount, credit_amount, net_amount, base_net_amount, not_due, current_bucket, days30, days60, days90, max_days_overdue",
    )
    .eq("organization_id", orgId)
    .gt("net_amount", 0.01)
    .order("net_amount", { ascending: false });
  if (businessId) q = q.eq("business_id", businessId);
  if (branchId) q = q.eq("branch_id", branchId);

  const { data, error } = await q;
  if (error) throw error;

  return ((data || []) as any[])
    .filter((r) => r.contact_id)
    .map((r) => ({
      contactId: r.contact_id,
      contactName: r.contact_name || "Unknown",
      currency: r.currency,
      openDocumentCount: Number(r.open_document_count) || 0,
      openAmount: Number(r.open_amount) || 0,
      creditAmount: Number(r.credit_amount) || 0,
      netAmount: Number(r.net_amount) || 0,
      baseNetAmount: Number(r.base_net_amount) || 0,
      notDue: Number(r.not_due) || 0,
      current: Number(r.current_bucket) || 0,
      days30: Number(r.days30) || 0,
      days60: Number(r.days60) || 0,
      days90: Number(r.days90) || 0,
      maxDaysOverdue: Number(r.max_days_overdue) || 0,
    }));
}

export interface PayableCounterparty {
  contactId: string;
  contactName: string;
  netAmount: number;
  maxDaysOverdue: number;
}

/**
 * The set of vendors we actually owe money to right now — the AP mirror of
 * {@link fetchReceivableCounterparties}.
 *
 * ADR: this is the ONLY sanctioned cohort for vendor-statement runs and
 * payment sweeps. There is no `finance_ap_net_position` view, so the cohort is
 * folded here from the two GL-anchored engines: `finance_ap_open_items_as_of`
 * (residual per posted payable, JE-gated) less `finance_ap_vendor_credit_as_of`
 * (unapplied vendor credit). A cohort derived from `bills.status` is wrong in
 * both directions — it invents debt for unposted bills and hides payables that
 * came from manual journals on the AP control account.
 */
export async function fetchPayableCounterparties(
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
  asOf?: string,
): Promise<PayableCounterparty[]> {
  const reportDate = asOf ?? today();

  const [openRows, creditRows] = await Promise.all([
    fetchApOpenItemsAsOf(orgId, businessId, branchId, reportDate),
    fetchApVendorCreditAsOf(orgId, businessId, branchId, reportDate),
  ]);

  const byContact = new Map<string, PayableCounterparty>();

  for (const r of openRows) {
    if (!r.contact_id) continue;
    const amount = Number(r.base_residual_amount ?? r.residual_amount) || 0;
    // Overdue days come from the engine (measured against the as-of date), so
    // the cohort ages exactly like Aged Payables.
    const overdue = Number(r.days_past_due) || 0;
    const existing = byContact.get(r.contact_id);
    if (existing) {
      existing.netAmount += amount;
      existing.maxDaysOverdue = Math.max(existing.maxDaysOverdue, overdue);
    } else {
      byContact.set(r.contact_id, {
        contactId: r.contact_id,
        contactName: "Unknown",
        netAmount: amount,
        maxDaysOverdue: overdue,
      });
    }
  }

  for (const r of creditRows) {
    if (!r.contact_id) continue;
    const credit = Number(r.base_credit_amount ?? r.credit_amount) || 0;
    const existing = byContact.get(r.contact_id);
    if (existing) existing.netAmount -= credit;
  }


  const rows = Array.from(byContact.values()).filter((r) => r.netAmount > 0.01);
  if (rows.length === 0) return [];

  // Names are a display concern, resolved once for the whole cohort.
  const { data: names } = await supabase
    .from("contacts")
    .select("id, name")
    .in("id", rows.map((r) => r.contactId));
  const nameById = new Map((names || []).map((c: any) => [c.id, c.name as string]));
  for (const r of rows) r.contactName = nameById.get(r.contactId) || "Unknown";

  return rows.sort((a, b) => b.netAmount - a.netAmount);
}
