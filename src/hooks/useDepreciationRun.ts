/**
 * useDepreciationRun — Batch depreciation posting service
 * 
 * Calculates monthly depreciation for active fixed assets and posts
 * journal entries via useGLPosting (respecting fiscal period locks).
 */

import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useGLPosting } from "./useGLPosting";
import { useDefaultAccounts } from "./useDefaultAccounts";
import { useFiscalPeriods } from "./useFiscalPeriods";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { format, endOfMonth, startOfMonth } from "date-fns";
import type { FixedAsset, AssetCategory } from "./useFixedAssets";

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
  depreciationAccountId: string | null;
  accumulatedDepreciationAccountId: string | null;
}

export function useDepreciationRun() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { postToGL } = useGLPosting();
  const { getFixedAssetAccountMappings } = useDefaultAccounts();
  const { isDateLocked } = useFiscalPeriods();
  const { user } = useAuth();
  const [isRunning, setIsRunning] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const calculateMonthlyDepreciation = (
    purchasePrice: number,
    residualValue: number,
    usefulLifeYears: number,
    method: string,
    bookValue: number,
    depreciationRate?: number | null
  ): number => {
    if (bookValue <= residualValue) return 0;

    if (method === "straight_line") {
      const depreciableAmount = purchasePrice - residualValue;
      const monthlyDep = depreciableAmount / (usefulLifeYears * 12);
      return Math.min(Math.round(monthlyDep * 100) / 100, bookValue - residualValue);
    } else if (method === "reducing_balance" || method === "declining_balance") {
      const rate = depreciationRate || (100 / usefulLifeYears);
      const yearlyDep = bookValue * (rate / 100);
      const monthlyDep = yearlyDep / 12;
      return Math.min(Math.round(monthlyDep * 100) / 100, bookValue - residualValue);
    }
    return 0;
  };

  /** Fetch active assets with their categories */
  const fetchActiveAssets = async () => {
    if (!currentOrg?.id || !currentBusiness?.id) return [];

    const query = supabase
      .from("fixed_assets")
      .select(`*, category:asset_categories(*)`)
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .eq("status", "active");

    const { data, error } = await query;
    if (error) throw error;
    return data as (FixedAsset & { category: AssetCategory | null })[];
  };

  /** Preview depreciation for a given period without posting */
  const previewDepreciation = useCallback(async (periodDate: string): Promise<DepreciationPreviewItem[]> => {
    setIsPreviewing(true);
    try {
      const assets = await fetchActiveAssets();
      const mappings = getFixedAssetAccountMappings();
      const preview: DepreciationPreviewItem[] = [];

      for (const asset of assets) {
        // Depreciation is an accounting measure: it runs on the base-currency
        // cost stamped at acquisition (IAS 21 historical rate), never on the
        // transaction-currency purchase_price.
        const baseCost = Number(asset.base_purchase_price ?? asset.purchase_price);
        const baseResidual = Number(asset.base_residual_value ?? asset.residual_value);
        const bookValue = asset.book_value ?? (baseCost - asset.accumulated_depreciation);
        if (bookValue <= baseResidual) continue;

        const monthlyDep = calculateMonthlyDepreciation(
          baseCost,
          baseResidual,
          asset.useful_life_years,
          asset.depreciation_method,
          bookValue,
          asset.category?.depreciation_rate
        );

        if (monthlyDep <= 0) continue;

        preview.push({
          assetId: asset.id,
          assetNumber: asset.asset_number,
          assetName: asset.name,
          categoryName: asset.category?.name || "Uncategorized",
          method: asset.depreciation_method,
          purchasePrice: baseCost,
          bookValue,
          residualValue: baseResidual,
          monthlyDepreciation: monthlyDep,
          depreciationAccountId: asset.category?.depreciation_account_id || mappings.depreciation_expense_id || null,
          accumulatedDepreciationAccountId: asset.category?.accumulated_depreciation_account_id || mappings.accumulated_depreciation_account_id || null,
        });
      }

      return preview;
    } finally {
      setIsPreviewing(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  /** Run depreciation for a specific month and post journal entries */
  const runDepreciation = useCallback(async (periodDate: string): Promise<DepreciationRunResult> => {
    if (!currentOrg?.id || !user) throw new Error("Not authenticated");

    const periodEnd = format(endOfMonth(new Date(periodDate)), "yyyy-MM-dd");
    const periodStart = format(startOfMonth(new Date(periodDate)), "yyyy-MM-dd");

    // Check if the period is locked
    if (isDateLocked(periodEnd)) {
      throw new Error(`The fiscal period containing ${format(new Date(periodDate), "MMMM yyyy")} is closed. Cannot post depreciation.`);
    }

    setIsRunning(true);
    const result: DepreciationRunResult = {
      assetsProcessed: 0,
      entriesPosted: 0,
      totalAmount: 0,
      errors: [],
    };

    try {
      const preview = await previewDepreciation(periodDate);
      // Re-fetch assets to get branch_id + business_id for JE stamping
      const assetsForRun = await fetchActiveAssets();
      const assetById = new Map(assetsForRun.map((a) => [a.id, a]));

      for (const item of preview) {
        if (!item.depreciationAccountId || !item.accumulatedDepreciationAccountId) {
          result.errors.push(`${item.assetNumber}: Missing depreciation GL account mappings. Configure in category or Finance Settings.`);
          continue;
        }

        try {
          // Check if depreciation already posted for this asset+period
          const { data: existing } = await supabase
            .from("depreciation_schedules")
            .select("id")
            .eq("asset_id", item.assetId)
            .eq("period_start", periodStart)
            .eq("is_posted", true)
            .maybeSingle();

          if (existing) {
            result.errors.push(`${item.assetNumber}: Depreciation already posted for ${format(new Date(periodDate), "MMMM yyyy")}`);
            continue;
          }

          const assetRow = assetById.get(item.assetId);
          const assetBranchId = assetRow?.branch_id ?? null;

          // Post journal entry: Dr Depreciation Expense, Cr Accumulated Depreciation
          const journalEntryId = await postToGL({
            source_type: "depreciation",
            source_id: item.assetId,
            reference: `DEP-${item.assetNumber}-${format(new Date(periodDate), "yyyy-MM")}`,
            memo: `Monthly depreciation: ${item.assetName} - ${format(new Date(periodDate), "MMM yyyy")}`,
            entry_date: periodEnd,
            // Phase 10: stamp the JE with the asset's branch so depreciation
            // posts under the same branch as the asset (branch-safe reporting).
            branch_id: assetBranchId,
            entries: [
              {
                account_id: item.depreciationAccountId,
                debit_amount: item.monthlyDepreciation,
                credit_amount: 0,
                description: `Depreciation expense - ${item.assetName}`,
              },
              {
                account_id: item.accumulatedDepreciationAccountId,
                debit_amount: 0,
                credit_amount: item.monthlyDepreciation,
                description: `Accumulated depreciation - ${item.assetName}`,
              },
            ],
          });

          if (!journalEntryId) {
            result.errors.push(`${item.assetNumber}: GL posting returned no entry ID`);
            continue;
          }

          // Record in depreciation_schedules
          const newAccumulated = (item.purchasePrice - item.bookValue) + item.monthlyDepreciation;
          const newBookValue = item.purchasePrice - newAccumulated;

          await supabase.from("depreciation_schedules").insert({
            organization_id: currentOrg.id,
            business_id: assetRow?.business_id ?? currentBusiness?.id ?? null,
            asset_id: item.assetId,
            period_start: periodStart,
            period_end: periodEnd,
            depreciation_amount: item.monthlyDepreciation,
            accumulated_depreciation: newAccumulated,
            book_value: Math.max(newBookValue, item.residualValue),
            journal_entry_id: journalEntryId,
            is_posted: true,
            posted_at: new Date().toISOString(),
            posted_by: user.id,
          } as any);

          // Update asset's accumulated_depreciation and book_value
          await supabase
            .from("fixed_assets")
            .update({
              accumulated_depreciation: newAccumulated,
              book_value: Math.max(newBookValue, item.residualValue),
            })
            .eq("id", item.assetId);

          result.entriesPosted++;
          result.totalAmount += item.monthlyDepreciation;
        } catch (err: any) {
          result.errors.push(`${item.assetNumber}: ${err.message}`);
        }

        result.assetsProcessed++;
      }

      if (result.entriesPosted > 0) {
        toast.success(`Depreciation posted: ${result.entriesPosted} entries totaling ${result.totalAmount.toFixed(2)}`);
      }

      if (result.errors.length > 0) {
        toast.warning(`${result.errors.length} asset(s) had issues. Check details.`);
      }

      return result;
    } finally {
      setIsRunning(false);
    }
  }, [currentOrg?.id, user, isDateLocked, previewDepreciation, postToGL]);

  return {
    previewDepreciation,
    runDepreciation,
    calculateMonthlyDepreciation,
    isRunning,
    isPreviewing,
  };
}