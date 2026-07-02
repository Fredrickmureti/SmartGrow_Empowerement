/**
 * useEmployeesInboxCounts — Employees-domain "work waiting" counts for HR.
 *
 * Mirrors useAttendanceInboxCounts / useLeaveInboxCounts / useTimesheetInboxCounts.
 * Surfaces three workforce-administration queues:
 *  - pendingOnboarding: active onboarding-checklist items not yet completed
 *  - expiringContracts: contracts with end_date within the next 90 days
 *  - openExitClearance: exit-clearance items not yet completed
 *
 * Used by EmployeesSubNav (Inbox group badge) and ModuleInboxCard (module="employees").
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { addDays, format } from "date-fns";

export interface EmployeesInboxCounts {
  pendingOnboarding: number;
  expiringContracts: number;
  openExitClearance: number;
  total: number;
}

const ZERO: EmployeesInboxCounts = {
  pendingOnboarding: 0,
  expiringContracts: 0,
  openExitClearance: 0,
  total: 0,
};

export function useEmployeesInboxCounts() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const queryKey = ["employees-inbox-counts", currentOrg?.id, currentBusiness?.id];

  const { data = ZERO, isLoading } = useQuery<EmployeesInboxCounts>({
    queryKey,
    enabled: !!currentOrg?.id,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!currentOrg?.id) return ZERO;

      const today = format(new Date(), "yyyy-MM-dd");
      const horizon = format(addDays(new Date(), 90), "yyyy-MM-dd");

      const scope = (q: any) => {
        let r = q.eq("organization_id", currentOrg.id);
        if (currentBusiness?.id) r = r.eq("business_id", currentBusiness.id);
        return r;
      };

      const [onboardingRes, contractsRes, exitRes] = await Promise.all([
        scope(
          supabase
            .from("employee_onboarding_items" as any)
            .select("id", { count: "exact", head: true })
            .neq("status", "completed"),
        ),
        scope(
          supabase
            .from("employee_contracts" as any)
            .select("id", { count: "exact", head: true })
            .not("end_date", "is", null)
            .gte("end_date", today)
            .lte("end_date", horizon)
            .eq("status", "active"),
        ),
        scope(
          supabase
            .from("employee_exit_clearance_items" as any)
            .select("id", { count: "exact", head: true })
            .neq("status", "completed"),
        ),
      ]);

      const pendingOnboarding = onboardingRes.count ?? 0;
      const expiringContracts = contractsRes.count ?? 0;
      const openExitClearance = exitRes.count ?? 0;

      return {
        pendingOnboarding,
        expiringContracts,
        openExitClearance,
        total: pendingOnboarding + expiringContracts + openExitClearance,
      };
    },
  });

  return { counts: data, isLoading };
}
