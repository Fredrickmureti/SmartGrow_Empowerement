/**
 * usePOSContextReady — single source of truth for "is the POS shell safe
 * to render branch-critical UI?"
 *
 * Returns the conjunction of every dependency POS surfaces rely on:
 *   - auth user resolved
 *   - organization hydrated
 *   - current company (business) hydrated
 *   - branch list + currentBranch hydrated
 *
 * While `!ready`, the POS shell should render a neutral loading state.
 * Once `ready` is true, `currentBranch == null` is a genuine terminal
 * state ("no branch access") and should be surfaced with a dedicated UI
 * — never as a transient destructive chip.
 *
 * Rationale: enterprise POS shells (Lightspeed, Toast, Square) mount the
 * operational surface only after the conjunction of all branch-critical
 * dependencies. Reading any single context's `isLoading` in isolation
 * leaks the hydration gap between siblings.
 *
 * See docs/audit/2026-05-20-pos-security-settings-and-branch-hydration.md.
 */
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";

export type POSContextReadyReason =
  | "auth"
  | "organization"
  | "business"
  | "branch"
  | "ready";

export interface POSContextReady {
  ready: boolean;
  reason: POSContextReadyReason;
}

export function usePOSContextReady(): POSContextReady {
  const { user, isLoading: authLoading } = useAuth();
  const { currentOrg, isLoading: orgLoading } = useOrganization();
  const { currentBusiness, isLoading: businessLoading } = useBusinesses();
  const { currentBranch, isLoading: branchLoading } = useBranch();

  if (authLoading || !user) return { ready: false, reason: "auth" };
  if (orgLoading || !currentOrg) return { ready: false, reason: "organization" };
  if (businessLoading || !currentBusiness) return { ready: false, reason: "business" };
  if (branchLoading || !currentBranch) return { ready: false, reason: "branch" };
  return { ready: true, reason: "ready" };
}
