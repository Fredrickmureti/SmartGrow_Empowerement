/**
 * useDashboardScope — single source of truth for dashboard scope.
 *
 * Resolves which slice of data the dashboard should show based on:
 *   - the currently selected business (from BusinessContext)
 *   - the currently selected branch (from BranchContext)
 *   - the user's `dashboard.view_consolidated` permission (queried via
 *     `has_dashboard_permission` RPC, cached for the session)
 *   - the user's opt-in `consolidatedView` flag on BranchContext
 *
 * The HQ branch is treated as a normal branch_only scope — selecting
 * "Headquarters" shows HQ figures only, NOT all-branch totals. This
 * matches QuickBooks Location Tracking and Odoo branch behavior:
 * consolidated reporting is an explicit, permissioned mode, not a
 * silent default of "HQ".
 *
 * Returns `isReady = false` while business / branches load so callers
 * can disable queries instead of issuing them with a half-formed scope.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBranch } from "@/contexts/BranchContext";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import type { DashboardScope, DashboardScopeKind } from "@/lib/withScope";

export type { DashboardScope, DashboardScopeKind } from "@/lib/withScope";

export interface ResolvedDashboardScope extends DashboardScope {
  /** Human-readable label, e.g. "AccrualFlow · Nairobi (HQ)" or "AccrualFlow · All Branches (Consolidated)". */
  scopeLabel: string;
  /** True when the user is granted `dashboard.view_consolidated` server-side. */
  isConsolidatedAuthorized: boolean;
  /** True when the user is granted `dashboard.view_executive` server-side. */
  isExecutiveAuthorized: boolean;
  /** True once business and branch context have loaded. */
  isReady: boolean;
  /** True when the selected branch is HQ in branch_only mode. */
  isHqSelected: boolean;
}

const PERMS: Array<"dashboard.view_branch" | "dashboard.view_hq" | "dashboard.view_consolidated" | "dashboard.view_executive"> = [
  "dashboard.view_branch",
  "dashboard.view_hq",
  "dashboard.view_consolidated",
  "dashboard.view_executive",
];

export function useDashboardScope(): ResolvedDashboardScope {
  const { user } = useAuth();
  const { currentBusiness } = useBusinesses();
  const { currentBranch, branches, isLoading: branchesLoading, consolidatedView } = useBranch();

  // Cache permission lookups per (user, business) for the session.
  // Single batch RPC call replaces N sequential round-trips.
  const { data: perms } = useQuery({
    queryKey: ["dashboard-permissions", user?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!user?.id || !currentBusiness?.id) return {} as Record<string, boolean>;
      const { data, error } = await supabase.rpc("has_dashboard_permissions", {
        _user_id: user.id,
        _perms: PERMS as unknown as string[],
        _business_id: currentBusiness.id,
      } as any);
      if (error || !data || typeof data !== "object") {
        return {} as Record<string, boolean>;
      }
      const map = data as Record<string, unknown>;
      const out: Record<string, boolean> = {};
      for (const perm of PERMS) out[perm] = map[perm] === true;
      return out;
    },
    enabled: !!user?.id && !!currentBusiness?.id,
    staleTime: 5 * 60 * 1000,
  });

  return useMemo<ResolvedDashboardScope>(() => {
    const isConsolidatedAuthorized = !!perms?.["dashboard.view_consolidated"];
    const isExecutiveAuthorized = !!perms?.["dashboard.view_executive"];
    const businessId = currentBusiness?.id ?? null;
    const businessName = currentBusiness?.name ?? "";
    const isReady = !!businessId && !branchesLoading;

    // No branches at all → business_only.
    if (!branches || branches.length === 0) {
      return {
        kind: "business_only",
        businessId,
        branchId: null,
        scopeLabel: businessName ? `${businessName} · Business-wide` : "Business-wide",
        isConsolidatedAuthorized,
        isExecutiveAuthorized,
        isReady,
        isHqSelected: false,
      };
    }

    // Consolidated view requested AND authorized → all_branches.
    if (consolidatedView && isConsolidatedAuthorized) {
      return {
        kind: "all_branches",
        businessId,
        branchId: null,
        scopeLabel: businessName
          ? `${businessName} · All Branches (Consolidated)`
          : "All Branches (Consolidated)",
        isConsolidatedAuthorized,
        isExecutiveAuthorized,
        isReady,
        isHqSelected: false,
      };
    }

    // Default: branch_only — HQ is just a branch.
    const branch = currentBranch;
    const branchLabel = branch?.is_headquarters
      ? `${branch.name} (HQ)`
      : (branch?.name ?? "—");
    return {
      kind: "branch_only",
      businessId,
      branchId: branch?.id ?? null,
      scopeLabel: businessName ? `${businessName} · ${branchLabel}` : branchLabel,
      isConsolidatedAuthorized,
      isExecutiveAuthorized,
      isReady: isReady && !!branch?.id,
      isHqSelected: !!branch?.is_headquarters,
    };
  }, [perms, currentBusiness, currentBranch, branches, branchesLoading, consolidatedView]);
}