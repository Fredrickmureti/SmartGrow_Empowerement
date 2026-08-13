/**
 * Landed cost reporting reads.
 *
 * Every figure here comes from a server-side set-based aggregate over the
 * canonical tables (`landed_cost_allocations`, `inventory_cost_revaluations`,
 * `journal_entry_lines`). The browser never sums allocations itself and never
 * keeps a competing landed-cost total.
 */
import { useQuery } from "@tanstack/react-query";

import { useBusinesses } from "@/hooks/useBusinesses";
import {
  fetchLandedCostClearingExposure,
  fetchLandedCostReceiptSummary,
  fetchLandedCostValuationAttribution,
} from "./landedCostRpcs";

export interface LandedCostReceiptSummary {
  goods_receipt_id: string;
  voucher_count: number;
  allocated_amount: number;
  capitalized_amount: number;
  expensed_amount: number;
  posted_count: number;
  pending_count: number;
  currency: string | null;
}

/** Landed cost attached to a set of goods receipts. Empty array = no query. */
export function useLandedCostReceiptSummary(receiptIds: string[]) {
  const ids = [...receiptIds].sort();
  const key = ids.join(",");

  const query = useQuery({
    queryKey: ["landed-cost-receipt-summary", key],
    enabled: ids.length > 0,
    queryFn: async (): Promise<LandedCostReceiptSummary[]> => {
      const data = await fetchLandedCostReceiptSummary(ids);
      return data.map((r) => ({
        goods_receipt_id: r.goods_receipt_id as string,
        voucher_count: Number(r.voucher_count ?? 0),
        allocated_amount: Number(r.allocated_amount ?? 0),
        capitalized_amount: Number(r.capitalized_amount ?? 0),
        expensed_amount: Number(r.expensed_amount ?? 0),
        posted_count: Number(r.posted_count ?? 0),
        pending_count: Number(r.pending_count ?? 0),
        currency: (r.currency as string | null) ?? null,
      }));
    },
  });

  const byReceipt = new Map<string, LandedCostReceiptSummary>();
  for (const row of query.data ?? []) byReceipt.set(row.goods_receipt_id, row);

  return { rows: query.data ?? [], byReceipt, loading: query.isLoading, error: query.error };
}

export interface LandedCostValuationAttribution {
  product_id: string;
  revaluation_count: number;
  uplift_amount: number;
  unit_cost_before: number | null;
  unit_cost_after: number | null;
  last_applied_at: string | null;
  last_voucher_id: string | null;
}

/** Landed cost uplift already applied to inventory value, per product. */
export function useLandedCostValuationAttribution(enabled = true) {
  const { currentBusiness } = useBusinesses();
  const bizId = currentBusiness?.id ?? null;

  const query = useQuery({
    queryKey: ["landed-cost-valuation-attribution", bizId],
    enabled: enabled && !!bizId,
    queryFn: async (): Promise<LandedCostValuationAttribution[]> => {
      const data = await fetchLandedCostValuationAttribution(bizId!);
      return data.map((r) => ({
        product_id: r.product_id as string,
        revaluation_count: Number(r.revaluation_count ?? 0),
        uplift_amount: Number(r.uplift_amount ?? 0),
        unit_cost_before: r.unit_cost_before === null ? null : Number(r.unit_cost_before),
        unit_cost_after: r.unit_cost_after === null ? null : Number(r.unit_cost_after),
        last_applied_at: (r.last_applied_at as string | null) ?? null,
        last_voucher_id: (r.last_voucher_id as string | null) ?? null,
      }));
    },
  });

  const byProduct = new Map<string, LandedCostValuationAttribution>();
  for (const row of query.data ?? []) byProduct.set(row.product_id, row);

  return { byProduct, loading: query.isLoading };
}

export interface LandedCostClearingExposure {
  clearing_account_id: string | null;
  clearing_balance: number;
  unposted_amount: number;
  unposted_count: number;
  currency: string | null;
}

/** Clearing-account balance plus the exposure still outside the ledger. */
export function useLandedCostClearingExposure() {
  const { currentBusiness } = useBusinesses();
  const bizId = currentBusiness?.id ?? null;

  const query = useQuery({
    queryKey: ["landed-cost-clearing-exposure", bizId],
    enabled: !!bizId,
    queryFn: async (): Promise<LandedCostClearingExposure> => {
      const raw = await fetchLandedCostClearingExposure(bizId!);
      return {
        clearing_account_id: (raw.clearing_account_id as string | null) ?? null,
        clearing_balance: Number(raw.clearing_balance ?? 0),
        unposted_amount: Number(raw.unposted_amount ?? 0),
        unposted_count: Number(raw.unposted_count ?? 0),
        currency: (raw.currency as string | null) ?? null,
      };
    },
  });

  return { exposure: query.data ?? null, loading: query.isLoading };
}
