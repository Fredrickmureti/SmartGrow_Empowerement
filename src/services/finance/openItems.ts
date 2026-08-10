/**
 * Canonical AR / AP open-item access.
 *
 * ADR: `finance_ar_open_items` / `finance_ap_open_items` are the ONLY source
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

/** Top counterparties by open residual, straight off the GL-gated projection. */
export async function fetchTopOpenCounterparties(
  side: "ar" | "ap",
  orgId: string,
  businessId?: string | null,
  branchId?: string | null,
  limit = 5,
): Promise<Array<{ name: string; amount: number; daysOverdue: number }>> {
  const view = side === "ar" ? "finance_ar_open_items" : "finance_ap_open_items";
  let q = supabase
    .from(view as any)
    .select("document_id, document_number, contact_id, document_date, due_date, residual_amount")
    .eq("organization_id", orgId)
    .gt("residual_amount", 0.01);
  if (businessId) q = q.eq("business_id", businessId);
  if (branchId) q = q.eq("branch_id", branchId);
  const { data, error } = await q;
  if (error) throw error;

  const rows = (data || []) as any[];
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
    const name = (r.contact_id && names.get(r.contact_id)) || "Unknown";
    const daysOverdue = daysOverdueFrom(r.due_date || r.document_date);
    const existing = byContact.get(name) || { name, amount: 0, daysOverdue: 0 };
    existing.amount += Number(r.residual_amount) || 0;
    existing.daysOverdue = Math.max(existing.daysOverdue, daysOverdue);
    byContact.set(name, existing);
  }

  // Net unapplied customer credit so a customer sitting on an advance is not
  // ranked as a top exposure. Same rule the aging RPC applies.
  if (side === "ar") {
    let cq = supabase
      .from("customer_credit_balances" as any)
      .select("contact_id, balance")
      .eq("organization_id", orgId)
      .gt("balance", 0.01);
    if (businessId) cq = cq.eq("business_id", businessId);
    const { data: credits } = await cq;
    const creditContactIds = Array.from(
      new Set(((credits || []) as any[]).map((c) => c.contact_id).filter(Boolean)),
    ).filter((id) => !names.has(id));
    if (creditContactIds.length > 0) {
      const { data: extra } = await supabase
        .from("contacts")
        .select("id, name")
        .in("id", creditContactIds);
      for (const c of extra || []) names.set(c.id, c.name);
    }
    for (const c of (credits || []) as any[]) {
      const name = (c.contact_id && names.get(c.contact_id)) || "Unknown";
      const existing = byContact.get(name);
      if (!existing) continue; // pure credit position — not an exposure to chase
      existing.amount -= Number(c.balance) || 0;
    }
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
 * `finance_ar_open_items` / `finance_ap_open_items`, never from a status list
 * over `invoices` / `bills`. Residual there nets every settlement channel
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
  const view = side === "ar" ? "finance_ar_open_items" : "finance_ap_open_items";
  const contactIds = Array.isArray(params.contactId) ? params.contactId : [params.contactId];
  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);
  const asOfDate = new Date(`${asOf}T00:00:00Z`);
  let q = supabase
    .from(view as any)
    .select("document_date, due_date, residual_amount")
    .eq("organization_id", params.orgId)
    .in("contact_id", contactIds)
    .lte("document_date", asOf)
    .gt("residual_amount", 0.01);
  if (params.businessId) q = q.eq("business_id", params.businessId);
  if (params.branchId) q = q.eq("branch_id", params.branchId);

  const { data, error } = await q;
  if (error) throw error;

  const buckets = emptyAgingBuckets();
  for (const row of (data || []) as any[]) {
    const residual = Number(row.residual_amount) || 0;
    if (residual <= 0.01) continue;
    addToAgingBuckets(
      buckets,
      residual,
      daysOverdueFrom(row.due_date || row.document_date, asOfDate),
    );
  }

  if (side === "ar") {
    const credit = await fetchUnappliedCustomerCredit(params.orgId, params.businessId, contactIds);
    if (credit > 0.01) addToAgingBuckets(buckets, -credit, 0);
  }

  return buckets;
}


/**
 * Unapplied customer credit (advance receipts / unapplied credit notes) for an
 * org, optionally narrowed to one contact. This is a genuine credit position on
 * the customer and reduces the net receivable — `get_ar_ap_aging_from_ledger`
 * and `get_ar_summary` both net it, so read-side helpers must too.
 */
export async function fetchUnappliedCustomerCredit(
  orgId: string,
  businessId?: string | null,
  contactId?: string | string[] | null,
): Promise<number> {
  let q = supabase
    .from("customer_credit_balances" as any)
    .select("balance")
    .eq("organization_id", orgId)
    .gt("balance", 0.01);
  if (businessId) q = q.eq("business_id", businessId);
  if (Array.isArray(contactId)) {
    if (contactId.length === 0) return 0;
    q = q.in("contact_id", contactId);
  } else if (contactId) {
    q = q.eq("contact_id", contactId);
  }

  const { data, error } = await q;
  if (error) return 0;
  return ((data || []) as any[]).reduce((sum, r) => sum + (Number(r.balance) || 0), 0);
}

