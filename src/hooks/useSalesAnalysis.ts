/**
 * useSalesAnalysis — the Sales Reports hook.
 *
 * Thin wrapper over `fetchSalesAnalysis` / `fetchSalesRevenueReconciliation`.
 * All aggregation and currency normalisation live in SQL; this hook only
 * carries reporting scope and cache keys.
 */

import { useQuery } from "@tanstack/react-query";
import {
  EMPTY_SALES_TOTALS,
  fetchSalesAnalysis,
  fetchSalesRevenueReconciliation,
  type SalesAnalysisResult,
  type SalesDimension,
} from "@/services/finance/salesAnalysis";

export interface UseSalesAnalysisOptions {
  orgId: string | null | undefined;
  businessId?: string | null;
  branchId?: string | null;
  from: string;
  to: string;
  dimension: SalesDimension;
  limit?: number | null;
  offset?: number;
  enabled?: boolean;
}

const EMPTY_RESULT = (
  dimension: SalesDimension,
  from: string,
  to: string,
): SalesAnalysisResult => ({
  dimension,
  from,
  to,
  rows: [],
  totals: { ...EMPTY_SALES_TOTALS },
  paging: { total_rows: 0, limit: null, offset: 0 },
});

export function useSalesAnalysis(options: UseSalesAnalysisOptions) {
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
      "sales-analysis",
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
      fetchSalesAnalysis({
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
    totals: query.data?.totals ?? { ...EMPTY_SALES_TOTALS },
  };
}

/** GL tie-out: document net sales vs revenue less returns and discounts. */
export function useSalesRevenueReconciliation(options: {
  orgId: string | null | undefined;
  businessId?: string | null;
  branchId?: string | null;
  from: string;
  to: string;
  enabled?: boolean;
}) {
  const { orgId, businessId = null, branchId = null, from, to, enabled = true } = options;

  return useQuery({
    queryKey: ["sales-revenue-reconciliation", orgId, businessId, branchId, from, to],
    queryFn: () =>
      fetchSalesRevenueReconciliation({
        orgId: orgId as string,
        businessId,
        branchId,
        from,
        to,
      }),
    enabled: Boolean(enabled && orgId && from && to),
  });
}
