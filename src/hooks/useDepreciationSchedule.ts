import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useGLPosting } from "./useGLPosting";
import { toast } from "sonner";
import { format, addMonths, startOfMonth, endOfMonth, differenceInMonths } from "date-fns";
import { normalizeError } from "@/services/resilience";

export interface DepreciationSchedule {
  id: string;
  organization_id: string;
  business_id: string | null;
  asset_id: string;
  period_start: string;
  period_end: string;
  depreciation_amount: number;
  accumulated_depreciation: number;
  book_value: number;
  journal_entry_id: string | null;
  is_posted: boolean;
  posted_at: string | null;
  posted_by: string | null;
  created_at: string;
}

export interface AssetWithSchedule {
  id: string;
  asset_number: string;
  name: string;
  purchase_date: string;
  purchase_price: number;
  residual_value: number;
  /** Base-currency cost stamped at acquisition. The accounting basis for depreciation. */
  base_purchase_price?: number | null;
  base_residual_value?: number | null;
  useful_life_years: number;
  depreciation_method: string;
  accumulated_depreciation: number;
  book_value: number | null;
  status: string;
  category?: {
    id: string;
    name: string;
    depreciation_account_id: string | null;
    accumulated_depreciation_account_id: string | null;
    depreciation_rate: number | null;
  } | null;
}

export function useDepreciationSchedule(assetId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { postToGL } = useGLPosting();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  // Fetch schedules for an asset
  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ["depreciation-schedules", organizationId, assetId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];
      let query = supabase
        .from("depreciation_schedules")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId);
      
      if (assetId) {
        query = query.eq("asset_id", assetId);
      }
      
      const { data, error } = await query.order("period_start", { ascending: true });
      if (error) throw error;
      return data as DepreciationSchedule[];
    },
    enabled: !!organizationId && !!businessId,
  });

  // Calculate depreciation for an asset
  const calculateDepreciation = (
    purchasePrice: number,
    residualValue: number,
    usefulLifeYears: number,
    method: string,
    accumulatedDepreciation: number,
    bookValue: number,
    depreciationRate?: number | null
  ): number => {
    if (bookValue <= residualValue) return 0;

    if (method === "straight_line") {
      const depreciableAmount = purchasePrice - residualValue;
      const monthlyDepreciation = depreciableAmount / (usefulLifeYears * 12);
      return Math.round(monthlyDepreciation * 100) / 100;
    } else if (method === "reducing_balance" || method === "declining_balance") {
      const rate = depreciationRate || (100 / usefulLifeYears);
      const yearlyDepreciation = bookValue * (rate / 100);
      const monthlyDepreciation = yearlyDepreciation / 12;
      // Ensure we don't depreciate below residual value
      const maxDepreciation = bookValue - residualValue;
      return Math.min(Math.round(monthlyDepreciation * 100) / 100, maxDepreciation);
    }
    return 0;
  };

  // Generate depreciation schedule for an asset
  const generateSchedule = useMutation({
    mutationFn: async (asset: AssetWithSchedule) => {
      if (!organizationId || !businessId) throw new Error("No company selected");

      const purchaseDate = new Date(asset.purchase_date);
      const endDate = addMonths(purchaseDate, asset.useful_life_years * 12);
      const today = new Date();
      
      const scheduleItems: Omit<DepreciationSchedule, "id" | "created_at">[] = [];
      let currentDate = startOfMonth(addMonths(purchaseDate, 1));
      let accumulatedDep = 0;
      // Schedules are an accounting artefact: they run on the base-currency cost
      // stamped at acquisition, not on the transaction-currency purchase price.
      const baseCost = Number(asset.base_purchase_price ?? asset.purchase_price);
      const baseResidual = Number(asset.base_residual_value ?? asset.residual_value);
      let bookValue = baseCost;

      while (currentDate <= endDate && bookValue > baseResidual) {
        const monthlyDep = calculateDepreciation(
          baseCost,
          baseResidual,
          asset.useful_life_years,
          asset.depreciation_method,
          accumulatedDep,
          bookValue,
          asset.category?.depreciation_rate
        );

        if (monthlyDep <= 0) break;

        accumulatedDep += monthlyDep;
        bookValue = baseCost - accumulatedDep;

        scheduleItems.push({
          organization_id: organizationId,
          business_id: businessId,
          asset_id: asset.id,
          period_start: format(startOfMonth(currentDate), "yyyy-MM-dd"),
          period_end: format(endOfMonth(currentDate), "yyyy-MM-dd"),
          depreciation_amount: monthlyDep,
          accumulated_depreciation: accumulatedDep,
          book_value: Math.max(bookValue, baseResidual),
          journal_entry_id: null,
          is_posted: false,
          posted_at: null,
          posted_by: null,
        });

        currentDate = addMonths(currentDate, 1);
      }

      // Delete existing schedules for this asset
      await supabase
        .from("depreciation_schedules")
        .delete()
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .eq("asset_id", asset.id);

      // Insert new schedules
      if (scheduleItems.length > 0) {
        const { error } = await supabase
          .from("depreciation_schedules")
          .insert(scheduleItems);
        if (error) throw error;
      }

      return scheduleItems.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["depreciation-schedules"] });
      toast.success(`Generated ${count} depreciation entries`);
    },
    onError: (error) => {
      toast.error("Failed to generate schedule: " + normalizeError(error).message);
    },
  });

  // Post a depreciation entry to the GL
  const postDepreciation = useMutation({
    mutationFn: async (schedule: DepreciationSchedule & { 
      asset: AssetWithSchedule;
    }) => {
      if (!organizationId || !user) throw new Error("Not authenticated");

      const { asset } = schedule;
      const depreciationAccountId = asset.category?.depreciation_account_id;
      const accumulatedAccountId = asset.category?.accumulated_depreciation_account_id;

      if (!depreciationAccountId || !accumulatedAccountId) {
        throw new Error("Asset category must have depreciation accounts configured");
      }

      // Create journal entry
      const journalEntryId = await postToGL({
        source_type: "depreciation",
        source_id: schedule.id,
        reference: `DEP-${asset.asset_number}-${schedule.period_start}`,
        memo: `Depreciation for ${asset.name} - ${format(new Date(schedule.period_start), "MMM yyyy")}`,
        entry_date: schedule.period_end,
        entries: [
          {
            account_id: depreciationAccountId,
            debit_amount: schedule.depreciation_amount,
            credit_amount: 0,
            description: `Depreciation expense - ${asset.name}`,
          },
          {
            account_id: accumulatedAccountId,
            debit_amount: 0,
            credit_amount: schedule.depreciation_amount,
            description: `Accumulated depreciation - ${asset.name}`,
          },
        ],
      });

      if (!journalEntryId) throw new Error("Failed to create journal entry");

      // Update schedule as posted
      const { error: updateError } = await supabase
        .from("depreciation_schedules")
        .update({
          journal_entry_id: journalEntryId,
          is_posted: true,
          posted_at: new Date().toISOString(),
          posted_by: user.id,
        })
        .eq("id", schedule.id);

      if (updateError) throw updateError;

      // Update asset accumulated depreciation
      await supabase
        .from("fixed_assets")
        .update({
          accumulated_depreciation: schedule.accumulated_depreciation,
          book_value: schedule.book_value,
        })
        .eq("id", asset.id);

      return journalEntryId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["depreciation-schedules"] });
      queryClient.invalidateQueries({ queryKey: ["fixed-assets"] });
      toast.success("Depreciation posted to GL");
    },
    onError: (error) => {
      toast.error("Failed to post depreciation: " + normalizeError(error).message);
    },
  });

  // Get unposted schedules for a period
  const getUnpostedSchedules = async (periodEnd: string) => {
    const { data, error } = await supabase
      .from("depreciation_schedules")
      .select(`
        *,
        asset:fixed_assets(
          id,
          asset_number,
          name,
          purchase_price,
          residual_value,
          currency,
          base_purchase_price,
          base_residual_value,
          status,
          category:asset_categories(
            id,
            name,
            depreciation_account_id,
            accumulated_depreciation_account_id
          )
        )
      `)
      .eq("organization_id", organizationId)
        .eq("business_id", businessId)
      .eq("is_posted", false)
      .lte("period_end", periodEnd);

    if (error) throw error;
    return data;
  };

  return {
    schedules,
    isLoading,
    generateSchedule,
    postDepreciation,
    getUnpostedSchedules,
    calculateDepreciation,
    postedSchedules: schedules.filter((s) => s.is_posted),
    pendingSchedules: schedules.filter((s) => !s.is_posted),
  };
}
