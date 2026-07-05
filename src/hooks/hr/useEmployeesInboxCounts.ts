/**
 * useEmployeesInboxCounts — Employees-domain "work waiting" counts for HR.
 *
 * Mirrors useAttendanceInboxCounts / useLeaveInboxCounts / useTimesheetInboxCounts.
 * Surfaces the workforce-administration queues that keep an HR ops desk honest:
 *  - pendingOnboarding: active onboarding-checklist items not yet completed
 *  - stalledOnboarding: onboarding cases started > 30d ago and still open
 *  - expiringContracts: contracts with end_date within the next 90 days
 *  - probationEnding: contracts with probation_end_date within the next 30 days
 *  - expiringDocuments: employee documents with expiry_date within the next 90 days
 *  - openExitClearance: exit-clearance items not yet completed
 *
 * Used by EmployeesSubNav (Inbox group badge) and ModuleInboxCard (module="employees").
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { addDays, format, subDays } from "date-fns";

export interface EmployeesInboxCounts {
  pendingOnboarding: number;
  stalledOnboarding: number;
  expiringContracts: number;
  probationEnding: number;
  expiringDocuments: number;
  openExitClearance: number;
  total: number;
}

const ZERO: EmployeesInboxCounts = {
  pendingOnboarding: 0,
  stalledOnboarding: 0,
  expiringContracts: 0,
  probationEnding: 0,
  expiringDocuments: 0,
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

      const now = new Date();
      const today = format(now, "yyyy-MM-dd");
      const horizon90 = format(addDays(now, 90), "yyyy-MM-dd");
      const horizon30 = format(addDays(now, 30), "yyyy-MM-dd");
      const stalledCutoff = subDays(now, 30).toISOString();

      const scope = (q: any) => {
        let r = q.eq("organization_id", currentOrg.id);
        if (currentBusiness?.id) r = r.eq("business_id", currentBusiness.id);
        return r;
      };

      const [
        onboardingRes,
        stalledRes,
        contractsRes,
        probationRes,
        docsRes,
        exitRes,
      ] = await Promise.all([
        scope(
          supabase
            .from("employee_onboarding_items" as any)
            .select("id", { count: "exact", head: true })
            .neq("status", "completed"),
        ),
        scope(
          supabase
            .from("employee_onboarding" as any)
            .select("id", { count: "exact", head: true })
            .neq("status", "completed")
            .lt("started_at", stalledCutoff),
        ),
        scope(
          supabase
            .from("employee_contracts" as any)
            .select("id", { count: "exact", head: true })
            .not("end_date", "is", null)
            .gte("end_date", today)
            .lte("end_date", horizon90)
            .eq("status", "active"),
        ),
        scope(
          supabase
            .from("employee_contracts" as any)
            .select("id", { count: "exact", head: true })
            .not("probation_end_date", "is", null)
            .gte("probation_end_date", today)
            .lte("probation_end_date", horizon30)
            .eq("status", "active"),
        ),
        scope(
          supabase
            .from("employee_documents" as any)
            .select("id", { count: "exact", head: true })
            .not("expiry_date", "is", null)
            .gte("expiry_date", today)
            .lte("expiry_date", horizon90),
        ),
        scope(
          supabase
            .from("employee_exit_clearance_items" as any)
            .select("id", { count: "exact", head: true })
            .neq("status", "completed"),
        ),
      ]);

      const pendingOnboarding = onboardingRes.count ?? 0;
      const stalledOnboarding = stalledRes.count ?? 0;
      const expiringContracts = contractsRes.count ?? 0;
      const probationEnding = probationRes.count ?? 0;
      const expiringDocuments = docsRes.count ?? 0;
      const openExitClearance = exitRes.count ?? 0;

      return {
        pendingOnboarding,
        stalledOnboarding,
        expiringContracts,
        probationEnding,
        expiringDocuments,
        openExitClearance,
        total:
          pendingOnboarding +
          stalledOnboarding +
          expiringContracts +
          probationEnding +
          expiringDocuments +
          openExitClearance,
      };
    },
  });

  return { counts: data, isLoading };
}
