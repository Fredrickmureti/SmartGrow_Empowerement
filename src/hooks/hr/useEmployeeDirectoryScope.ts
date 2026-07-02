/**
 * useEmployeeDirectoryScope — the SINGLE source of truth for how the
 * Employees directory and its stats decide which branches to include.
 *
 * Both `useEmployeesPaged` and `useEmployeeDirectoryStats` MUST consume
 * this hook (and pass `branchIds` through to their RPC) so the two
 * pipelines can never disagree about scope again. See ADR-0039.
 *
 * Resolution order (ADR-0039 compliant — Person owned by Business, Branch
 * is a 0..N assignment, not an ownership column):
 *   1. User has `viewEmployees` (Admin / Owner / HR) → null (no branch
 *      filter). Admins ALWAYS see every employee in the active business,
 *      including HQ/remote staff with no branch assignment. The branch
 *      chip in BranchContext scopes transactional pages (POS, attendance,
 *      timesheets) — it must not hide people from the HR directory.
 *   2. User is branch-restricted (no `viewEmployees` AND has explicit
 *      assignments) → assigned branch ids. RLS still applies on top.
 *   3. Otherwise → null.
 */
import { useMemo } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "@/hooks/usePermissions";
import { useHrScope } from "./useHrScope";

export interface EmployeeDirectoryScope {
  orgId: string | undefined;
  businessId: string | undefined;
  /** Pass-through to `p_branch_ids`. `null` disables the server filter. */
  branchIds: string[] | null;
  /** Stable string for React Query keys. */
  branchIdsKey: string;
  isReady: boolean;
}

export function useEmployeeDirectoryScope(): EmployeeDirectoryScope {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { branchIds: assigned, isBranchRestricted, isReady } = useHrScope();
  const { can } = usePermissions();
  const canViewAll = can("viewEmployees");

  return useMemo<EmployeeDirectoryScope>(() => {
    const effective: string[] | null = canViewAll
      ? null
      : isBranchRestricted && assigned.length > 0
        ? assigned
        : null;
    return {
      orgId: currentOrg?.id,
      businessId: currentBusiness?.id ?? undefined,
      branchIds: effective,
      branchIdsKey: effective ? effective.slice().sort().join(",") : "",
      isReady: isReady && !!currentOrg?.id && !!currentBusiness?.id,
    };
  }, [
    currentOrg?.id,
    currentBusiness?.id,
    canViewAll,
    assigned,
    isBranchRestricted,
    isReady,
  ]);
}
