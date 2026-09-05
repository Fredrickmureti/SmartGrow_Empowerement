import { useMemo } from "react";
import { useSession, type BranchScopeMode, type SessionBranch } from "@/contexts/SessionContext";

export interface BranchScopeState {
  /** Widest branch scope granted by the user's access groups in the current org. */
  scope: BranchScopeMode;
  /** Branches the user may operate in (already scope-filtered server side). */
  branches: SessionBranch[];
  /** True when the user may work across every branch of the organization. */
  isOrgWide: boolean;
  /** True when the user only sees their own clients/loans inside their branches. */
  isOwnPortfolioOnly: boolean;
  /** Default branch to preselect in pickers (headquarters first, else first allowed). */
  defaultBranchId: string | null;
  /** Authoritative client-side check. Server RLS enforces the same rule. */
  canAccessBranch: (branchId: string | null | undefined) => boolean;
}

/**
 * Branch dimension of authorization.
 *
 * The database is the source of truth: `user_has_module_permission_in_branch`
 * enforces the same rule inside RLS. This hook exists so the UI can hide or
 * disable out-of-scope branches instead of letting a user submit work that the
 * server will reject.
 */
export function useBranchScope(): BranchScopeState {
  let scope: BranchScopeMode = "assigned";
  let branches: SessionBranch[] = [];

  try {
    const { currentOrg } = useSession();
    scope = currentOrg?.branch_scope ?? "assigned";
    branches = currentOrg?.allowed_branches ?? [];
  } catch {
    // SessionContext is not mounted in every render tree (e.g. auth screens).
  }

  return useMemo(() => {
    const allowedIds = new Set(branches.map((b) => b.id));
    const defaultBranch = branches.find((b) => b.is_headquarters) ?? branches[0] ?? null;

    return {
      scope,
      branches,
      isOrgWide: scope === "all",
      isOwnPortfolioOnly: scope === "own_portfolio",
      defaultBranchId: defaultBranch?.id ?? null,
      canAccessBranch: (branchId) => {
        if (!branchId) return true; // org-wide view
        if (scope === "all") return true;
        return allowedIds.has(branchId);
      },
    };
  }, [scope, branches]);
}
