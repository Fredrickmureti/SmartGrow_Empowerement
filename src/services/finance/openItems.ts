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

  const today = Date.now();
  const byContact = new Map<string, { name: string; amount: number; daysOverdue: number }>();
  for (const r of rows) {
    const name = (r.contact_id && names.get(r.contact_id)) || "Unknown";
    const due = r.due_date || r.document_date;
    const daysOverdue = due
      ? Math.floor((today - new Date(due).getTime()) / 86_400_000)
      : 0;
    const existing = byContact.get(name) || { name, amount: 0, daysOverdue: 0 };
    existing.amount += Number(r.residual_amount) || 0;
    existing.daysOverdue = Math.max(existing.daysOverdue, daysOverdue);
    byContact.set(name, existing);
  }

  return Array.from(byContact.values())
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

export interface OpenItemAging {
  current: number;
  days30: number;
  days60: number;
  days90: number;
  days120: number;
  total: number;
}

export const EMPTY_OPEN_ITEM_AGING: OpenItemAging = {
  current: 0,
  days30: 0,
  days60: 0,
  days90: 0,
  days120: 0,
  total: 0,
};

/**
 * Per-counterparty open-item aging, straight off the GL-gated projection.
 *
 * ADR: contact-level receivable / payable figures MUST come from
 * `finance_ar_open_items` / `finance_ap_open_items`, never from a status list
 * over `invoices` / `bills`. Residual there nets every settlement channel
 * (cash receipts and applied credit notes) and only counts documents with a
 * posted journal entry on the control account.
 */
export async function fetchContactOpenItemAging(
  side: "ar" | "ap",
  params: {
    orgId: string;
    contactId: string;
    businessId?: string | null;
    branchId?: string | null;
  },
): Promise<OpenItemAging> {
  const view = side === "ar" ? "finance_ar_open_items" : "finance_ap_open_items";
  let q = supabase
    .from(view as any)
    .select("document_date, due_date, residual_amount")
    .eq("organization_id", params.orgId)
    .eq("contact_id", params.contactId)
    .gt("residual_amount", 0.01);
  if (params.businessId) q = q.eq("business_id", params.businessId);
  if (params.branchId) q = q.eq("branch_id", params.branchId);

  const { data, error } = await q;
  if (error) throw error;

  const now = Date.now();
  const buckets: OpenItemAging = { ...EMPTY_OPEN_ITEM_AGING };
  for (const row of (data || []) as any[]) {
    const residual = Number(row.residual_amount) || 0;
    if (residual <= 0.01) continue;
    const due = row.due_date || row.document_date;
    const daysOverdue = due
      ? Math.floor((now - new Date(due).getTime()) / 86_400_000)
      : 0;
    if (daysOverdue <= 0) buckets.current += residual;
    else if (daysOverdue <= 30) buckets.days30 += residual;
    else if (daysOverdue <= 60) buckets.days60 += residual;
    else if (daysOverdue <= 90) buckets.days90 += residual;
    else buckets.days120 += residual;
    buckets.total += residual;
  }
  return buckets;
}
