/**
 * useDepreciationRun — thin caller of the authoritative depreciation seam.
 *
 * The browser never computes an accounting amount here. Both the preview and
 * the posting go to the same database routines:
 *
 *   fa_depreciation_plan(business, period, branch)  — read-only projection
 *   fa_post_depreciation(business, period, branch)  — recomputes and posts
 *
 * `fa_post_depreciation` takes no amount from the caller: it recalculates from
 * the stored asset/category configuration, enforces the fiscal-period lock,
 * branch/business scope, GL mappings and the one-event-per-asset-per-period
 * rule, and posts through the existing `post_journal_entry_atomic` engine.
 */

import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { toast } from "sonner";
import { format, startOfMonth } from "date-fns";
import { normalizeError } from "@/services/resilience";

export interface DepreciationRunResult {
  assetsProcessed: number;
  entriesPosted: number;
  totalAmount: number;
  errors: string[];
}

export interface DepreciationPreviewItem {
  assetId: string;
  assetNumber: string;
  assetName: string;
  categoryName: string;
  method: string;
  purchasePrice: number;
  bookValue: number;
  residualValue: number;
  monthlyDepreciation: number;
  remainingDepreciable: number;
  depreciationAccountId: string | null;
  accumulatedDepreciationAccountId: string | null;
  /** Server-decided reason this asset will not be depreciated this period. */
  blocker: string | null;
  alreadyPosted: boolean;
}

/** Plain-language wording for the server's blocker codes. */
export const DEPRECIATION_BLOCKER_LABEL: Record<string, string> = {
  ALREADY_POSTED: "Already posted for this period",
  UNSUPPORTED_METHOD: "Depreciation method not supported",
  INVALID_USEFUL_LIFE: "Useful life is not set",
  MISSING_GL_MAPPING: "Depreciation accounts not mapped",
  NOT_IN_SERVICE: "Not yet in service",
  FULLY_DEPRECIATED: "Fully depreciated",
};

export function useDepreciationRun() {
  const { currentBusiness } = useBusinesses();
  const scope = useFinanceScope();
  const [isRunning, setIsRunning] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const businessId = currentBusiness?.id ?? null;
  const branchId = scope.branchId;

  /** Preview: reads the authoritative plan. Writes nothing. */
  const previewDepreciation = useCallback(
    async (periodDate: string): Promise<DepreciationPreviewItem[]> => {
      if (!businessId) return [];
      setIsPreviewing(true);
      try {
        const { data, error } = await supabase.rpc("fa_depreciation_plan", {
          _business_id: businessId,
          _period_date: format(startOfMonth(new Date(periodDate)), "yyyy-MM-dd"),
          _branch_id: branchId,
        } as any);
        if (error) throw error;

        return ((data as any[]) ?? []).map((row) => {
          const cost = Number(row.base_cost ?? 0);
          const prior = Number(row.prior_accumulated ?? 0);
          return {
            assetId: row.asset_id,
            assetNumber: row.asset_number,
            assetName: row.asset_name,
            categoryName: row.category_name || "Uncategorized",
            method: row.method,
            purchasePrice: cost,
            bookValue: cost - prior,
            residualValue: Number(row.base_residual ?? 0),
            monthlyDepreciation: Number(row.depreciation_amount ?? 0),
            remainingDepreciable: Number(row.remaining_depreciable ?? 0),
            depreciationAccountId: row.expense_account_id ?? null,
            accumulatedDepreciationAccountId: row.accumulated_account_id ?? null,
            blocker: row.blocker ?? null,
            alreadyPosted: !!row.already_posted,
          } satisfies DepreciationPreviewItem;
        });
      } finally {
        setIsPreviewing(false);
      }
    },
    [businessId, branchId],
  );

  /** Posting: the server recomputes and posts. No amount is sent. */
  const runDepreciation = useCallback(
    async (periodDate: string): Promise<DepreciationRunResult> => {
      if (!businessId) throw new Error("No company selected");
      setIsRunning(true);
      try {
        const { data, error } = await supabase.rpc("fa_post_depreciation", {
          _business_id: businessId,
          _period_date: format(startOfMonth(new Date(periodDate)), "yyyy-MM-dd"),
          _branch_id: branchId,
        } as any);
        if (error) throw new Error(normalizeError(error).message);

        const payload = (data ?? {}) as any;
        const errors: string[] = ((payload.errors ?? []) as any[]).map(
          (e) =>
            `${e.asset_number}: ${DEPRECIATION_BLOCKER_LABEL[e.reason] ?? e.reason}`,
        );
        const result: DepreciationRunResult = {
          assetsProcessed: Number(payload.posted ?? 0) + Number(payload.skipped ?? 0),
          entriesPosted: Number(payload.posted ?? 0),
          totalAmount: Number(payload.total_amount ?? 0),
          errors,
        };

        if (result.entriesPosted > 0) {
          toast.success(`Depreciation posted for ${result.entriesPosted} asset(s)`);
        } else if (errors.length === 0) {
          toast.info("Nothing to depreciate for this period");
        }
        return result;
      } finally {
        setIsRunning(false);
      }
    },
    [businessId, branchId],
  );

  return { previewDepreciation, runDepreciation, isRunning, isPreviewing };
}
