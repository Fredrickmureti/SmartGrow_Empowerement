/**
 * useCanSwitchScope — single predicate deciding whether a "Change scope"
 * affordance should be offered to the user.
 *
 * Mirrors the visibility rules already enforced inside ContextSwitcherSheet
 * (workspace/company/branch sections only render when ≥ 2 of that kind
 * exist) so the trigger and the sheet stay in agreement: we never invite
 * the user to open a switcher that would render empty.
 *
 * `shouldShowTrigger` is true when at least one of:
 *   - the user belongs to ≥ 2 workspaces, OR
 *   - the current workspace has ≥ 2 companies, OR
 *   - the current company has ≥ 2 branches, OR
 *   - the user can create a workspace or company from the sheet.
 *
 * Single-target tenants with no create permissions get `false` — matches
 * Odoo / NetSuite / Dynamics behavior (switcher hidden when there is
 * nothing to switch to).
 */
import { useMemo } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";
import { usePermissions } from "@/hooks/usePermissions";
import { useDashboardScope } from "@/hooks/useDashboardScope";

export interface CanSwitchScopeResult {
  /** True when ≥ 2 alternatives exist in any of: workspaces, companies, branches. */
  hasAlternatives: boolean;
  /** True when the user can create a workspace or company from the sheet. */
  canCreateAny: boolean;
  /**
   * True when the user is server-side authorized for the dashboard
   * `view_consolidated` permission AND there are ≥ 2 branches to
   * consolidate across. A single-branch tenant has nothing to
   * consolidate (the "all branches" view equals the one branch), so
   * the trigger stays hidden — matches Odoo / NetSuite / Dynamics /
   * QuickBooks Enterprise.
   */
  canSwitchToConsolidated: boolean;
  /**
   * Render a "Change scope" affordance iff there is actually a *different*
   * scope to switch to. Create-only permissions no longer flip this — the
   * canonical place to create a new workspace / company / branch is
   * Settings, not a scope switcher. Matches Odoo / NetSuite / Dynamics.
   */
  shouldShowTrigger: boolean;
  /**
   * True only when the trigger is hidden (single-target tenant) AND the
   * user can create new entities. Surfaces a quiet "Add company / branch"
   * hint in places that want one; most callers should leave this to Settings.
   */
  shouldShowCreateHint: boolean;
}

export function useCanSwitchScope(): CanSwitchScopeResult {
  const { organizations } = useOrganization();
  const { businesses } = useBusinesses();
  const { branches } = useBranch();
  const permissions = usePermissions();
  const dashboardScope = useDashboardScope();

  return useMemo(() => {
    const hasAlternatives =
      organizations.length >= 2 ||
      businesses.length >= 2 ||
      branches.length >= 2;
    const canCreateAny =
      !!permissions.canManageOrganization || !!permissions.canManageBusiness;
    const canSwitchToConsolidated =
      !!dashboardScope.isConsolidatedAuthorized && branches.length >= 2;
    return {
      hasAlternatives,
      canCreateAny,
      canSwitchToConsolidated,
      shouldShowTrigger: hasAlternatives || canSwitchToConsolidated,
      shouldShowCreateHint: !hasAlternatives && canCreateAny,
    };
  }, [
    organizations.length,
    businesses.length,
    branches.length,
    permissions.canManageOrganization,
    permissions.canManageBusiness,
    dashboardScope.isConsolidatedAuthorized,
  ]);
}
