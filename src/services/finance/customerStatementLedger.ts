/**
 * customerStatementLedger.ts — the ONE read of the canonical AR subledger
 * used by every customer-statement surface (screen, PDF, CSV, XLSX, email).
 *
 * ADR 0027: `customer_ledger_entries` (a view over `ar_subledger_entries`)
 * is the source of financial truth for a customer's account. No statement
 * surface may re-derive the account from `invoices` / `payments` /
 * `credit_notes` — that produced draft/void leakage, allocation-blind
 * payment totals, and a credit-note status vocabulary that never existed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerLedgerRow } from "./customerStatementDataset";

export interface FetchCustomerLedgerArgs {
  businessId: string;
  branchId?: string | null;
  /** One contact, or the whole commercial-partner family. */
  contactIds: string[];
  /** Everything up to and including this date is fetched (opening + period). */
  periodEnd: string;
  organizationId?: string | null;
}

export async function fetchCustomerLedgerRows(
  client: SupabaseClient,
  args: FetchCustomerLedgerArgs,
): Promise<CustomerLedgerRow[]> {
  if (!args.businessId) throw new Error("fetchCustomerLedgerRows: businessId required");
  if (!args.contactIds?.length) return [];

  let q: any = (client as any)
    .from("customer_ledger_entries")
    .select("entry_date, doc_type, doc_id, doc_ref, debit, credit, currency, created_at")
    .eq("business_id", args.businessId)
    .in("contact_id", args.contactIds)
    .lte("entry_date", args.periodEnd)
    .order("entry_date", { ascending: true })
    .order("created_at", { ascending: true });

  if (args.organizationId) q = q.eq("organization_id", args.organizationId);
  // Branch isolation is enforced on the read, not in the browser: a
  // branch-scoped statement must never surface sibling-branch documents.
  if (args.branchId) q = q.eq("branch_id", args.branchId);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as CustomerLedgerRow[];
}
