/**
 * useHrScope — single source of truth for HR module scoping.
 *
 * Mirrors useFinanceScope. Returns the org/business/branch context plus
 * a derived `branchIds` array and `isBranchRestricted` flag so HR hooks
 * can hard-filter their queries to the branches the current user is
 * actually assigned to.
 *
 * isBranchRestricted = true  →  user has explicit branch assignments AND
 *                               lacks the broad `viewEmployees` admin perm.
 *                               Frontend MUST add `branch_id IN (...)` to
 *                               its SELECTs as defense-in-depth on top of
 *                               the row-level RLS.
 *
 * isBranchRestricted = false →  HR Officer / Admin / Owner: see all
 *                               employees in the active business scope.
 */
import { useEffect, useMemo, useState } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";

export interface HrScope {
  orgId: string;
  businessId: string | null;
  /** Currently selected branch (null = consolidated). */
  branchId: string | null;
  /** All branch ids the current user is allowed to see (empty = all). */
  branchIds: string[];
  /**
   * True when the user does NOT have `viewEmployees` and HAS at least one
   * explicit branch assignment in the active business. Hooks should add
   * `.in("branch_id", branchIds)` whenever this is true.
   */
  isBranchRestricted: boolean;
  isReady: boolean;
  scopeLabel: string;
}

export function useHrScope(): HrScope {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const { user } = useAuth();
  const { can } = usePermissions();

  const [assignedBranchIds, setAssignedBranchIds] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!user || !currentOrg || !currentBusiness) {
        setAssignedBranchIds(null);
        return;
      }
      const { data, error } = await supabase
        .from("user_branch_assignments")
        .select("branch_id")
        .eq("user_id", user.id)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);
      if (cancelled) return;
      if (error) {
        // Fail closed: treat as no assignments (the broader RLS still applies).
        setAssignedBranchIds([]);
        return;
      }
      setAssignedBranchIds((data ?? []).map((r) => r.branch_id as string));
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [user?.id, currentOrg?.id, currentBusiness?.id]);

  return useMemo<HrScope>(() => {
    const orgId = currentOrg?.id ?? "";
    const businessId = currentBusiness?.id ?? null;
    const branchId = currentBranch?.id ?? null;
    const hasViewEmployees = can("viewEmployees");
    const assigned = assignedBranchIds ?? [];
    // Branch-restricted if the user is NOT a broad HR admin AND has explicit
    // assignments. (No assignments = "HQ user, no scope" — keep wide-open
    // behavior so onboarding doesn't silently hide every employee.)
    const isBranchRestricted = !hasViewEmployees && assigned.length > 0;
    // When a single branch is selected, narrow further to that branch.
    const branchIds = branchId
      ? [branchId]
      : isBranchRestricted ? assigned : [];

    const businessLabel = currentBusiness?.name ?? "Business";
    const branchLabel = branchId
      ? currentBranch?.name ?? "Branch"
      : isBranchRestricted
        ? `${assigned.length} assigned branches`
        : "All Branches";

    return {
      orgId,
      businessId,
      branchId,
      branchIds,
      isBranchRestricted,
      isReady: !!orgId && !!businessId && assignedBranchIds !== null,
      scopeLabel: `${businessLabel} · ${branchLabel}`,
    };
  }, [
    currentOrg?.id,
    currentBusiness?.id,
    currentBusiness?.name,
    currentBranch?.id,
    currentBranch?.name,
    assignedBranchIds,
    can,
  ]);
}