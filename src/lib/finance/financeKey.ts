/**
 * financeKey — canonical React Query key builder for the Finance module.
 *
 * Every Finance query MUST include businessId AND branchId in its cache key
 * so that switching companies or branches invalidates stale data
 * automatically. Forgetting either has caused real branch-leakage incidents
 * where the previous branch's totals stayed on screen for ~30s after a
 * switch.
 *
 * Usage:
 *   const { businessId, branchId, isConsolidated } = useFinanceScope();
 *   useQuery({
 *     queryKey: financeKey({ businessId, branchId, isConsolidated }, "ar", "aging"),
 *     queryFn: ...,
 *   });
 *
 * Branch-scope segment encoding:
 *   - branch UUID  → "b:<uuid>"
 *   - consolidated → "consolidated"
 *   - all-branches default (single-branch business) → "all"
 */
import type { FinanceScope } from "@/hooks/finance/useFinanceScope";

export type FinanceScopeKeyInput = Pick<FinanceScope, "businessId" | "branchId" | "isConsolidated">;

export function financeKey(scope: FinanceScopeKeyInput, ...parts: readonly unknown[]) {
  const branchSeg = scope.branchId
    ? `b:${scope.branchId}`
    : scope.isConsolidated
      ? "consolidated"
      : "all";
  return ["finance", scope.businessId ?? "no-biz", branchSeg, ...parts] as const;
}
