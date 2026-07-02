import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { usePOSEtims } from "@/hooks/pos/usePOSEtims";

export interface EtimsReadinessStatus {
  isReady: boolean;
  needsSync: boolean;
  taxCodeCount: number;
  itemClassificationCount: number;
  unitOfMeasureCount: number;
  isLoading: boolean;
}

/**
 * Hook to check if eTIMS standard codes have been synced and the system is ready for compliance.
 * Returns readiness status and counts for various code types.
 */
export function useEtimsReadinessCheck(): EtimsReadinessStatus {
  const { currentOrg } = useOrganization();
  const { isEtimsEnabled } = usePOSEtims();

  const { data: codeCounts, isLoading } = useQuery({
    queryKey: ["etims-codes-count", currentOrg?.id],
    queryFn: async () => {
      // Fetch counts for different code types in parallel
      const [taxTypes, itemClassifications, unitOfMeasure] = await Promise.all([
        supabase
          .from("etims_standard_codes")
          .select("*", { count: "exact", head: true })
          .eq("code_type", "tax_type")
          .eq("is_active", true),
        supabase
          .from("etims_standard_codes")
          .select("*", { count: "exact", head: true })
          .eq("code_type", "item_classification")
          .eq("is_active", true),
        supabase
          .from("etims_standard_codes")
          .select("*", { count: "exact", head: true })
          .eq("code_type", "unit_of_measure")
          .eq("is_active", true),
      ]);

      return {
        taxCodeCount: taxTypes.count || 0,
        itemClassificationCount: itemClassifications.count || 0,
        unitOfMeasureCount: unitOfMeasure.count || 0,
      };
    },
    enabled: !!currentOrg && isEtimsEnabled,
    staleTime: 30000, // Cache for 30 seconds
  });

  const taxCodeCount = codeCounts?.taxCodeCount || 0;
  const itemClassificationCount = codeCounts?.itemClassificationCount || 0;
  const unitOfMeasureCount = codeCounts?.unitOfMeasureCount || 0;

  // System is ready if eTIMS is disabled OR all required codes are available
  const hasRequiredCodes = taxCodeCount > 0;
  const isReady = !isEtimsEnabled || hasRequiredCodes;
  const needsSync = isEtimsEnabled && !hasRequiredCodes;

  return {
    isReady,
    needsSync,
    taxCodeCount,
    itemClassificationCount,
    unitOfMeasureCount,
    isLoading: isEtimsEnabled ? isLoading : false,
  };
}
