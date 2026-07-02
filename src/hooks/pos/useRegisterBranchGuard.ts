/**
 * useRegisterBranchGuard — Stage B (branch isolation).
 *
 * Resolves the branch a register belongs to and compares it against the
 * caller's currently-active branch. Used by the POS terminal route to
 * prevent operating a register from outside its owning branch context.
 *
 * Returns one of three states:
 *   - "checking"     : register lookup in flight
 *   - "ok"           : register matches active branch (or HQ-overseer mode)
 *   - "missing"      : register id does not exist for this company
 *   - "wrong-branch" : register belongs to another branch; caller must
 *                      switch branch context before the terminal will mount
 *
 * HQ / no-branch mode (`currentBranch == null`) is treated as
 * "wrong-branch" for the terminal route specifically: cashiers must
 * commit to a branch before opening a till so transactions, drawer
 * events, and stock movements post to the right operational scope.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";

export type RegisterBranchGuardState =
  | { status: "checking" }
  | { status: "ok"; registerBranchId: string }
  | { status: "missing" }
  | {
      status: "wrong-branch";
      registerBranchId: string;
      registerBranchName: string | null;
      activeBranchId: string | null;
    };

export function useRegisterBranchGuard(registerId: string | undefined): RegisterBranchGuardState {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();

  const { data, isLoading } = useQuery({
    queryKey: [
      "pos-register-branch-guard",
      currentOrg?.id,
      currentBusiness?.id,
      registerId,
    ],
    queryFn: async () => {
      if (!registerId || !currentOrg?.id || !currentBusiness?.id) return null;
      // SCOPE-EXEMPT: PK lookup, then verify org/business below.
      const { data, error } = await supabase
        .from("pos_registers")
        .select("id, organization_id, business_id, branch_id, branch:branches(id, name)")
        .eq("id", registerId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      if (
        data.organization_id !== currentOrg.id ||
        data.business_id !== currentBusiness.id
      ) {
        // Belongs to a different company — treat as missing for this caller.
        return null;
      }
      return data;
    },
    enabled: !!registerId && !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 60_000,
  });

  if (!registerId) return { status: "missing" };
  if (isLoading) return { status: "checking" };
  if (!data) return { status: "missing" };

  const registerBranchId = data.branch_id as string;
  if (currentBranch?.id && currentBranch.id === registerBranchId) {
    return { status: "ok", registerBranchId };
  }
  return {
    status: "wrong-branch",
    registerBranchId,
    registerBranchName:
      (data.branch as { id: string; name: string } | null)?.name ?? null,
    activeBranchId: currentBranch?.id ?? null,
  };
}
