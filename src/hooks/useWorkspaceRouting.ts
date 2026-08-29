/**
 * useWorkspaceRouting
 *
 * Single, canonical "where should this user be?" selector for steady-state
 * route guards. Replaces the per-guard ad-hoc combinations of
 * `authLoading`, `sessionLoading`, `sessionReady`, `organizations.length`,
 * and `currentOrg` that previously lived in `OnboardingGuard`,
 * `InstitutionRoute`, and `OnboardingGate`.
 *
 * Why a single selector:
 *   Workspace resolution used to be a four-layer client-side state machine
 *   (postLoginRedirect, OnboardingGuard, InstitutionRoute,
 *   SelectOrganization). Each layer had its own "loading" rule and its own
 *   redirect, and any one of them firing `<Navigate to="/select-organization">`
 *   on an unhappy frame would flash the picker URL on reload. Collapsing
 *   the decision into one discriminated union means guards only render;
 *   they don't decide. The decision lives in one place, in one set of
 *   tests, with one set of branches to reason about.
 *
 * Distinct from:
 *   - `src/lib/auth/flowRouter.ts`         — one-shot post-login resolver
 *     (called from /login, /select-organization, /onboarding-setup). It
 *     answers "where do I send this user RIGHT NOW after sign-in?".
 *   - `src/hooks/useWorkspaceContextReady.ts` — install-state predicate
 *     (orgs + companies + installed-apps catalog). Used by app-shell
 *     surfaces to decide between "loader" and "activate UI".
 *   - `useWorkspaceRouting` (this file)     — steady-state guard selector.
 *     Used by every protected route to decide between loader / empty
 *     state / onboarding redirect / render children.
 */
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";

export type WorkspaceRoutingStatus =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "platform-admin" }
  | { status: "vendor-portal" }
  | { status: "unauthenticated" }
  | { status: "needs-onboarding" }
  | { status: "no-orgs" }
  | { status: "ready"; orgId: string };

export function useWorkspaceRouting(): WorkspaceRoutingStatus {
  const { user, isLoading: authLoading } = useAuth();
  const {
    sessionData,
    sessionReady,
    sessionError,
    isLoading: sessionLoading,
    currentOrg,
  } = useSession();
  const { isPlatformAdmin, isChecking: adminChecking } = usePlatformAdmin();

  // 1. Auth must be resolved (signed-in OR confirmed signed-out).
  if (authLoading) return { status: "loading" };

  // 2. No user: hand off to the auth layer.
  if (!user) return { status: "unauthenticated" };

  // 3. Vendor portal users have their own subtree.
  if (user.user_metadata?.is_vendor_portal === true) {
    return { status: "vendor-portal" };
  }

  // 4. Platform-admin probe.
  if (adminChecking) return { status: "loading" };
  if (isPlatformAdmin) return { status: "platform-admin" };

  // 5. Hard session failure: retries exhausted and we have no usable
  //    payload to fall back to. Surface an explicit error branch so the
  //    guard renders a failure card instead of looping on the loader or
  //    flashing a misleading "no workspace" state. If we have *stale*
  //    sessionData, fall through to the normal resolution — a banner
  //    surface elsewhere can offer a refresh.
  if (sessionError && !sessionData) {
    return { status: "error", error: sessionError };
  }

  // 6. Session payload must be coherent. `sessionReady` already gates
  //    the "isLoading=false but currentOrg memo stale" tick.
  if (sessionLoading || !sessionReady || !sessionData) {
    return { status: "loading" };
  }

  const orgs = sessionData.organizations;
  const onboardingCompleted = user.user_metadata?.onboarding_completed === true;

  // 7. Zero memberships.
  if (orgs.length === 0) {
    if (!onboardingCompleted) return { status: "needs-onboarding" };
    return { status: "no-orgs" };
  }

  // 8. We have at least one membership.
  if (!currentOrg) return { status: "loading" };

  return { status: "ready", orgId: currentOrg.id };
}
