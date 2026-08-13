/**
 * Aged Payables — typed access to the single AP aging engine.
 *
 * ADR: `get_ap_aging_summary` is the ONLY payables aging source. It is built on
 * `finance_ap_open_items_as_of`, a point-in-time projection of the AP subledger
 * (`ap_subledger_entries`), so payments and vendor credits are counted only if
 * they happened on or before the as-of date. Re-running an old date reproduces
 * the number that date produced. Never recompute buckets or residuals in the
 * browser — the boundaries live in `finance_aging_bucket` in SQL.
 *
 * `finance_ap_aging_reconciliation` ties the aging total back to the AP control
 * account for the same date; a non-zero variance means the subledger and the GL
 * disagree and must be shown, not hidden.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { AgingBucketKey } from "@/services/finance/aging";

export interface ApAgingBill {
  id: string;
  billNumber: string;
  documentDate: string | null;
  dueDate: string | null;
  documentTotal: number;
  paid: number;
  credited: number;
  balance: number;
  baseBalance: number;
  currency: string | null;
  daysPastDue: number;
  bucket: AgingBucketKey;
  sourceKind: "bill" | "journal";
  journalEntryId: string | null;
}

export interface ApAgingVendor {
  vendorId: string;
  vendorName: string;
  not_due: number;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  gross: number;
  credit: number;
  total: number;
  bills: ApAgingBill[];
}

export interface ApAgingTotals {
  not_due: number;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  gross: number;
  credit: number;
  total: number;
  vendorCount: number;
}

export interface ApAgingReconciliation {
  agingTotal: number;
  controlAccountBalance: number;
  variance: number;
  inBalance: boolean;
}

export interface ApAgingResult {
  asOf: string;
  currency: string | null;
  vendors: ApAgingVendor[];
  totals: ApAgingTotals;
  reconciliation: ApAgingReconciliation | null;
}

export const EMPTY_AP_AGING_TOTALS: ApAgingTotals = {
  not_due: 0,
  current: 0,
  days30: 0,
  days60: 0,
  days90: 0,
  gross: 0,
  credit: 0,
  total: 0,
  vendorCount: 0,
};

const num = (v: unknown) => Number(v ?? 0) || 0;

export interface UseApAgingArgs {
  organizationId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  asOf: string;
  enabled?: boolean;
}

export function useApAging({
  organizationId,
  businessId,
  branchId,
  asOf,
  enabled = true,
}: UseApAgingArgs) {
  return useQuery<ApAgingResult>({
    queryKey: ["ap-aging", organizationId, businessId, branchId ?? "all", asOf],
    enabled: Boolean(enabled && organizationId && businessId),
    queryFn: async () => {
      const [summary, recon] = await Promise.all([
        supabase.rpc("get_ap_aging_summary" as never, {
          p_organization_id: organizationId,
          p_business_id: businessId,
          p_branch_id: branchId ?? null,
          p_as_of: asOf,
        } as never),
        supabase.rpc("finance_ap_aging_reconciliation" as never, {
          _org_id: organizationId,
          _business_id: businessId,
          _branch_id: branchId ?? null,
          _as_of: asOf,
        } as never),
      ]);

      if (summary.error) throw summary.error;

      const payload = (summary.data ?? {}) as Record<string, unknown>;
      const rawVendors = (payload.vendors ?? []) as Record<string, unknown>[];
      const rawTotals = (payload.totals ?? {}) as Record<string, unknown>;

      const vendors: ApAgingVendor[] = rawVendors.map((v) => ({
        vendorId: String(v.vendor_id ?? "unknown"),
        vendorName: String(v.vendor_name ?? "Unknown Vendor"),
        not_due: num(v.not_due),
        current: num(v.current),
        days30: num(v.days30),
        days60: num(v.days60),
        days90: num(v.days90),
        gross: num(v.gross),
        credit: num(v.credit),
        total: num(v.total),
        bills: ((v.bills ?? []) as Record<string, unknown>[]).map((b) => ({
          id: String(b.id),
          billNumber: String(b.bill_number ?? String(b.id).slice(0, 8)),
          documentDate: (b.document_date as string) ?? null,
          dueDate: (b.due_date as string) ?? null,
          documentTotal: num(b.document_total),
          paid: num(b.paid),
          credited: num(b.credited),
          balance: num(b.balance),
          baseBalance: num(b.base_balance),
          currency: (b.currency as string) ?? null,
          daysPastDue: num(b.days_past_due),
          bucket: (b.bucket as AgingBucketKey) ?? "current",
          sourceKind: (b.source_kind as "bill" | "journal") ?? "bill",
          journalEntryId: (b.journal_entry_id as string) ?? null,
        })),
      }));

      const reconRow = (
        Array.isArray(recon.data) ? recon.data[0] : recon.data
      ) as Record<string, unknown> | undefined;

      return {
        asOf: String(payload.as_of ?? asOf),
        currency: (payload.currency as string) ?? null,
        vendors,
        totals: {
          not_due: num(rawTotals.not_due),
          current: num(rawTotals.current),
          days30: num(rawTotals.days30),
          days60: num(rawTotals.days60),
          days90: num(rawTotals.days90),
          gross: num(rawTotals.gross),
          credit: num(rawTotals.credit),
          total: num(rawTotals.total),
          vendorCount: num(rawTotals.vendor_count),
        },
        reconciliation:
          !recon.error && reconRow
            ? {
                agingTotal: num(reconRow.aging_total),
                controlAccountBalance: num(reconRow.control_account_balance),
                variance: num(reconRow.variance),
                inBalance: Boolean(reconRow.in_balance),
              }
            : null,
      };
    },
  });
}
