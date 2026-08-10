/**
 * vendorStatementLedger.ts — the ONE read of the canonical AP subledger used
 * by every vendor-statement surface (screen, PDF, CSV, email).
 *
 * ADR 0028: `vendor_ledger_entries` is the source of financial truth for a
 * vendor account. No statement surface may re-derive it from `bills` /
 * `bill_payments` / `vendor_credit_notes`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorLedgerRow } from "./vendorStatementDataset";

export interface FetchVendorLedgerArgs {
  businessId: string;
  branchId?: string | null;
  /** One contact, or the whole commercial-partner family. */
  contactIds: string[];
  /** Everything up to and including this date is fetched (opening + period). */
  periodEnd: string;
  organizationId?: string | null;
}

export async function fetchVendorLedgerRows(
  client: SupabaseClient,
  args: FetchVendorLedgerArgs,
): Promise<VendorLedgerRow[]> {
  if (!args.businessId) throw new Error("fetchVendorLedgerRows: businessId required");
  if (!args.contactIds?.length) return [];

  let q: any = (client as any)
    .from("vendor_ledger_entries")
    .select("entry_date, doc_type, doc_id, doc_ref, debit, credit, currency, created_at")
    .eq("business_id", args.businessId)
    .in("contact_id", args.contactIds)
    .lte("entry_date", args.periodEnd)
    .order("entry_date", { ascending: true })
    .order("created_at", { ascending: true });

  if (args.organizationId) q = q.eq("organization_id", args.organizationId);
  // Branch isolation is enforced on the read, not in the browser.
  if (args.branchId) q = q.eq("branch_id", args.branchId);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as VendorLedgerRow[];
}
