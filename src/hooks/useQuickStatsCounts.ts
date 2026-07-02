import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

/**
 * Lightweight hook that fetches real counts for CRM leads and HR employees
 * for use on the Home page QuickStats. Uses count-only queries for performance.
 */
export function useQuickStatsCounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const { data, isLoading } = useQuery({
    queryKey: ["quick-stats-counts", currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return { leadCount: 0, employeeCount: 0 };

      // Run both count queries in parallel
      const leadQuery = supabase
        .from("crm_leads")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true);

      // Canonical read model: every "active employee" count in the app
      // must derive from `v_employees_canonical.is_operationally_active`.
      // Querying `employees.is_active` directly drifts the moment a new
      // lifecycle state is added.
      const empQuery = (supabase as any)
        .from("v_employees_canonical")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_operationally_active", true);


      const [leadRes, empRes] = await Promise.all([leadQuery, empQuery]);

      return {
        leadCount: leadRes.count ?? 0,
        employeeCount: empRes.count ?? 0,
      };
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 60_000,
  });

  return {
    leadCount: data?.leadCount ?? 0,
    employeeCount: data?.employeeCount ?? 0,
    isLoading,
  };
}
