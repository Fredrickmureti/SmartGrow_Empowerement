/**
 * AP subledger ↔ GL reconciliation drill-down.
 *
 * `finance_ap_aging_reconciliation` answers "is the AP control account equal to
 * the aging total on this date?" as a single number. When it is not,
 * `finance_ap_reconciliation_detail` answers "which vendors cause it, and why?"
 *
 * Both run the SAME point-in-time engine (`finance_ap_open_items_as_of` +
 * `finance_ap_vendor_credit_as_of`) against the SAME subledger rows, so the
 * detail rows always sum to the header variance. The browser does no
 * reconciliation arithmetic — it renders what SQL computed.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type ApVarianceReason =
  | "unconvertible_currency"
  | "unattributed_ledger"
  | "missing_from_projection"
  | "missing_from_ledger"
  | "amount_mismatch";

export interface ApReconciliationRow {
  contactId: string | null;
  contactName: string;
  /**
   * ADR 0136: projection and variance figures are `number | null`. `null` means
   * a document under this vendor has no exchange rate on file, so no
   * base-currency comparison against the ledger is possible — the row is a
   * genuine unknown, not a zero variance.
   */
  projectionOpen: number | null;
  projectionCredit: number | null;
  projectionNet: number | null;
  ledgerNet: number;
  variance: number | null;
  reason: ApVarianceReason;
  documentCount: number;
  unconvertibleDocumentCount: number;
}

export const AP_VARIANCE_REASON_LABELS: Record<ApVarianceReason, string> = {
  unconvertible_currency: "No exchange rate on file",
  unattributed_ledger: "Ledger entry with no vendor",
  missing_from_projection: "In the ledger, absent from aging",
  missing_from_ledger: "In aging, absent from the ledger",
  amount_mismatch: "Amounts disagree",
};

export const AP_VARIANCE_REASON_HINTS: Record<ApVarianceReason, string> = {
  unconvertible_currency:
    "A document for this vendor is in a currency with no rate on file for this date, so it cannot be compared with the base-currency control account. Add the rate in Currency settings, then re-run.",
  unattributed_ledger:
    "A journal posted to the AP control account without a vendor. It moves the control account but can never be aged — attach a vendor to the line.",
  missing_from_projection:
    "The vendor has an AP control-account balance, but no open document or credit projects it. Usually a document posted outside the bill/credit-note engines.",
  missing_from_ledger:
    "An open document exists with no posted AP control-account entry for it on this date. Usually a posting that failed or was reversed only in the ledger.",
  amount_mismatch:
    "Both sides know the vendor but disagree on the amount — typically a settlement recorded on one side only, or an FX rate difference.",
};

const num = (v: unknown) => Number(v ?? 0) || 0;
/** Preserves a NULL base-currency figure instead of coercing it to zero. */
const money = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v) || 0;

export interface UseApReconciliationArgs {
  organizationId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  asOf: string;
  enabled?: boolean;
}

export async function fetchApReconciliationDetail({
  organizationId,
  businessId,
  branchId,
  asOf,
}: UseApReconciliationArgs): Promise<ApReconciliationRow[]> {
  const { data, error } = await supabase.rpc("finance_ap_reconciliation_detail" as never, {
    _org_id: organizationId,
    _business_id: businessId,
    _branch_id: branchId ?? null,
    _as_of: asOf,
  } as never);

  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    contactId: (r.contact_id as string) ?? null,
    contactName: String(r.contact_name ?? "Unknown vendor"),
    projectionOpen: money(r.projection_open),
    projectionCredit: money(r.projection_credit),
    projectionNet: money(r.projection_net),
    ledgerNet: num(r.ledger_net),
    variance: money(r.variance),
    reason: (r.reason as ApVarianceReason) ?? "amount_mismatch",
    documentCount: num(r.document_count),
    unconvertibleDocumentCount: num(r.unconvertible_document_count),
  }));
}

export function useApReconciliationDetail(args: UseApReconciliationArgs) {
  const { organizationId, businessId, branchId, asOf, enabled = true } = args;

  return useQuery<ApReconciliationRow[]>({
    queryKey: ["ap-reconciliation-detail", organizationId, businessId, branchId ?? "all", asOf],
    enabled: Boolean(enabled && organizationId && businessId),
    placeholderData: (prev) => prev,
    queryFn: () => fetchApReconciliationDetail({ organizationId, businessId, branchId, asOf }),
  });
}
