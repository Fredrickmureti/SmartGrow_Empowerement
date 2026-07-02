/**
 * POS Stage B4 — HQ overseer detection.
 *
 * Returns whether the current user is authorised to view (read-only)
 * POS surfaces across all branches when no specific branch is selected.
 * Used to gate the "company-wide fallback" branch in `usePOSRegisters`,
 * `usePOSShifts`, and `usePOSCashiers`. Without this gate, *any* user
 * who happened to land in a no-branch state would see every register
 * in the company.
 *
 * Overseer authority is read-only by design. Mutations are still
 * blocked at the server layer by the Stage B3 triggers
 * (`assert_pos_caller_branch_access`) — a user with this flag can
 * *see* foreign-branch rows but cannot write to them without first
 * switching their active branch context.
 */
import { useOrganization } from "@/hooks/useOrganization";
import { useBranch } from "@/contexts/BranchContext";

const OVERSEER_ROLES = new Set(["owner", "admin", "super_admin"]);

export function usePOSOverseer() {
  const { userRole } = useOrganization();
  const { currentBranch } = useBranch();
  const role = userRole?.role ?? null;
  const canOversee = role !== null && OVERSEER_ROLES.has(role);
  // "Active" overseer mode = user has the capability AND has no specific
  // branch selected (the legitimate company-wide read-only view).
  const isOverseeing = canOversee && !currentBranch?.id;
  return { canOversee, isOverseeing };
}