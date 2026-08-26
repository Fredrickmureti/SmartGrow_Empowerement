/**
 * usePurchaseAnalysis — the Purchase Reports hook.
 *
 * Thin wrapper over `fetchPurchaseAnalysis` /
 * `fetchPurchaseExpenseReconciliation`. All aggregation and currency
 * normalisation live in SQL; this hook only carries reporting scope and cache
 * keys.
 */

import { useQuery } from "@tanstack/react-query";
import {
  EMPTY_PURCHASE_TOTALS,
  EMPTY_UNCONVERTIBLE,
  fetchPurchaseAnalysis,
  fetchPurchaseExpenseReconciliation,
  type PurchaseAnalysisResult,
  type PurchaseDimension,
} from "@/services/finance/purchaseAnalysis";

export interface UsePurchaseAnalysisOptions {
  orgId: string | null | undefined;
  businessId?: string | null;
  branchId?: string | null;
  from: string;
  to: string;
  dimension: PurchaseDimension;
  limit?: number | null;
  offset?: number;
  enabled?: boolean;
}

const EMPTY_RESULT = (
  dimension: PurchaseDimension,
  from: string,
  to: string,
): PurchaseAnalysisResult => ({
  dimension,
  from,
  to,
  rows: [],
  totals: { ...EMPTY_PURCHASE_TOTALS },
  unconvertible: { ...EMPTY_UNCONVERTIBLE },
  paging: { total_rows: 0, limit: null, offset: 0 },
});

export function usePurchaseAnalysis(options: UsePurchaseAnalysisOptions) {
  const {
    orgId,
    businessId = null,
    branchId = null,
    from,
    to,
    dimension,
    limit = null,
    offset = 0,
    enabled = true,
  } = options;

  const query = useQuery({
    queryKey: [
      "purchase-analysis",
      orgId,
      businessId,
      branchId,
      from,
      to,
      dimension,
      limit,
      offset,
    ],
    queryFn: () =>
      fetchPurchaseAnalysis({
        orgId: orgId as string,
        businessId,
        branchId,
        from,
        to,
        dimension,
        limit,
        offset,
      }),
    enabled: Boolean(enabled && orgId && from && to),
  });

  return {
    ...query,
    data: query.data ?? EMPTY_RESULT(dimension, from, to),
    rows: query.data?.rows ?? [],
    totals: query.data?.totals ?? { ...EMPTY_PURCHASE_TOTALS },
    unconvertible: query.data?.unconvertible ?? { ...EMPTY_UNCONVERTIBLE },
  };
}

/** GL tie-out: document net purchases vs the postings those documents made. */
export function usePurchaseExpenseReconciliation(options: {
  orgId: string | null | undefined;
  businessId?: string | null;
  branchId?: string | null;
  from: string;
  to: string;
  enabled?: boolean;
}) {
  const { orgId, businessId = null, branchId = null, from, to, enabled = true } = options;

  return useQuery({
    queryKey: ["purchase-expense-reconciliation", orgId, businessId, branchId, from, to],
    queryFn: () =>
      fetchPurchaseExpenseReconciliation({
        orgId: orgId as string,
        businessId,
        branchId,
        from,
        to,
      }),
    enabled: Boolean(enabled && orgId && from && to),
  });
}
