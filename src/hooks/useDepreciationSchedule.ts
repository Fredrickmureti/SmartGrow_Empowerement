/**
 * useDepreciationSchedule — read-only view of an asset's depreciation record.
 *
 * Depreciation amounts are decided by the database (`fa_depreciation_plan` /
 * `fa_post_depreciation`). This hook therefore reads only: it holds no
 * depreciation formula, generates nothing, and posts nothing. Posting lives in
 * `useDepreciationRun`.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

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

export function useDepreciationSchedule(assetId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ["depreciation-schedules", organizationId, businessId, assetId],
    queryFn: async () => {
      if (!organizationId || !businessId) return [];
      let query = supabase
        .from("depreciation_schedules")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("business_id", businessId);

      if (assetId) query = query.eq("asset_id", assetId);

      const { data, error } = await query.order("period_start", { ascending: true });
      if (error) throw error;
      return data as DepreciationSchedule[];
    },
    enabled: !!organizationId && !!businessId,
  });

  return {
    schedules,
    isLoading,
    postedSchedules: schedules.filter((s) => s.is_posted),
    pendingSchedules: schedules.filter((s) => !s.is_posted),
  };
}
