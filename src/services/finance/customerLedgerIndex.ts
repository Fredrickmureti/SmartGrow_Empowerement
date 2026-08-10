/**
 * Customer ledger directory (presentation-only read model).
 *
 * ADR 0027: `finance_ar_net_position` is the canonical projection for a
 * customer's open receivable position. This module only lists customers so a
 * user can pick one and open `/sales/customers/:id/ledger` — it never derives
 * balances of its own.
 */
import { supabase } from "@/integrations/supabase/client";

export interface CustomerLedgerIndexRow {
  contactId: string;
  contactName: string;
  netAmount: number;
  openAmount: number;
  creditAmount: number;
  openDocumentCount: number;
  maxDaysOverdue: number;
}

export async function fetchCustomerLedgerIndex(
  orgId: string,
  businessId?: string | null,
): Promise<CustomerLedgerIndexRow[]> {
  let q = supabase
    .from("finance_ar_net_position" as any)
    .select(
      "contact_id, contact_name, net_amount, open_amount, credit_amount, open_document_count, max_days_overdue",
    )
    .eq("organization_id", orgId);
  if (businessId) q = q.eq("business_id", businessId);

  const { data, error } = await q;
  if (error) throw error;

  // The projection is branch-grained; roll up to one row per customer.
  const byContact = new Map<string, CustomerLedgerIndexRow>();
  for (const r of (data ?? []) as any[]) {
    const id = r.contact_id as string;
    const existing = byContact.get(id);
    const row: CustomerLedgerIndexRow = existing ?? {
      contactId: id,
      contactName: r.contact_name || "Unknown",
      netAmount: 0,
      openAmount: 0,
      creditAmount: 0,
      openDocumentCount: 0,
      maxDaysOverdue: 0,
    };
    row.netAmount += Number(r.net_amount) || 0;
    row.openAmount += Number(r.open_amount) || 0;
    row.creditAmount += Number(r.credit_amount) || 0;
    row.openDocumentCount += Number(r.open_document_count) || 0;
    row.maxDaysOverdue = Math.max(row.maxDaysOverdue, Number(r.max_days_overdue) || 0);
    byContact.set(id, row);
  }

  return Array.from(byContact.values()).sort((a, b) => b.netAmount - a.netAmount);
}

/** Customers with no open receivables — still need a reachable ledger. */
export async function fetchLedgerSearchableCustomers(
  orgId: string,
  businessId?: string | null,
): Promise<Array<{ id: string; name: string }>> {
  let q: any = supabase
    .from("contacts" as any)
    .select("id, name")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .in("contact_type", ["customer", "both"])
    .order("name", { ascending: true })
    .limit(500);
  if (businessId) q = q.eq("business_id", businessId);

  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as any[]).map((c) => ({ id: c.id, name: c.name }));
}
