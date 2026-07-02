/**
 * useWorkspaceContextReady
 *
 * THE single readiness predicate for install-aware surfaces.
 *
 * The workspace install state, the org, the company, the platform-apps
 * catalog, and the per-app access state all hydrate asynchronously and
 * independently. Any UI that *changes content* based on whether an app
 * is installed (install gates, workspace landing pages, redirect-to-
 * activate logic, etc.) must wait until ALL of those signals are
 * authoritative before acting. Otherwise the user gets a false-negative
 * "Install POS" prompt during the hydration window for a tenant that
 * already installed POS — see `.lovable/plan.md` for the full RCA.
 *
 * Contract:
 *   - `ready === true`  → every dependency has produced an authoritative
 *                         answer for the current user + org. Consumers
 *                         may safely render install / activate UX.
 *   - `ready === false` → at least one dependency is still resolving.
 *                         Consumers MUST render a neutral loader, not
 *                         the "not installed" branch.
 *
 * `reason` is a human-readable signal of which dependency is blocking,
 * used for observability and the debug breadcrumb emitted by
 * `AppInstalledGate` when it redirects.
 */
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { usePlatformApps } from "@/hooks/usePlatformApps";
import { useAppAccess } from "@/hooks/useAppAccess";
import { useConnectivity } from "@/contexts/ConnectivityContext";
import { getAppById } from "@/lib/apps/registry";

export type WorkspaceReadyReason =
  | "auth"
  | "session"
  | "no_org"
  | "businesses"
  | "platform_apps"
  | "installed_apps"
  | "access"
  | "offline_cached"
  | "offline_unverified"
  | "ready";

export interface WorkspaceContextReady {
  ready: boolean;
  reason: WorkspaceReadyReason;
}

interface Options {
  /**
   * If provided, also requires per-app access state to have resolved.
   * Most install-aware surfaces should pass the app id they're gating
   * for so the predicate reflects what they actually depend on.
   */
  appId?: string;
  /**
   * If true (default), waits for at least one business to hydrate. Set
   * to false for portal flows / org-only surfaces that do not depend
   * on a company being selected.
   */
  requireBusiness?: boolean;
}

export function useWorkspaceContextReady(
  opts: Options = {},
): WorkspaceContextReady {
  const { appId, requireBusiness = true } = opts;

  const { user, isLoading: authLoading } = useAuth();
  const { sessionData, currentOrg, isLoading: sessionLoading, userType } =
    useSession();
  const { currentBusiness, businesses, isLoading: businessLoading } =
    useBusinesses();
  const { data: platformApps, isLoading: platformAppsLoading, isError: platformAppsError } =
    usePlatformApps();
  const { isReady: installedAppsReady, hasInitialSnapshot } = useInstalledApps();
  const { isLoading: accessLoading } = useAppAccess();
  const { isOffline } = useConnectivity();

  // 1. Auth must be resolved (signed-in OR confirmed signed-out).
  if (authLoading) return { ready: false, reason: "auth" };

  // No signed-in user: the install gate doesn't apply — surface as
  // "ready" so the auth layer above can do its own redirect without
  // being held behind a spinner forever.
  if (!user) return { ready: true, reason: "ready" };

  // 2. Session payload must be resolved.
  if (sessionLoading || !sessionData) return { ready: false, reason: "session" };

  // 3. We need an org selected (unless user has none — terminal state).
  if (!currentOrg) {
    if (sessionData.organizations.length === 0) {
      return { ready: true, reason: "no_org" };
    }
    return { ready: false, reason: "no_org" };
  }

  // 4. BusinessContext: portal users skip this.
  if (requireBusiness && userType !== "portal") {
    if (businessLoading) return { ready: false, reason: "businesses" };
    // If the org genuinely has no business yet, that's a terminal state
    // (handled by the company-setup flow), not a hydration gap.
    if (!currentBusiness && businesses.length === 0) {
      return { ready: true, reason: "businesses" };
    }
  }

  // 5. Platform apps catalog. If it errored, fall through — the
  // `useInstalledApps` core-app fallback uses a hard-coded list that
  // covers the safety case; we should not block forever on a catalog
  // outage.
  if (platformAppsLoading && !platformAppsError && !platformApps) {
    return { ready: false, reason: "platform_apps" };
  }

  // 6. Installed apps: the headline dependency.
  if (!installedAppsReady) {
    // Phase 7 — offline parity. If the network is down but we have a
    // fresh same-org cache, paint the workspace optimistically rather
    // than block the user forever on a fetch that cannot land.
    if (isOffline) {
      if (hasInitialSnapshot) {
        return { ready: true, reason: "offline_cached" };
      }
      return { ready: false, reason: "offline_unverified" };
    }
    return { ready: false, reason: "installed_apps" };
  }

  // 7. Per-app access (entitlements / trials) — only when the caller
  // asked us to gate on a specific app.
  if (appId) {
    const app = getAppById(appId);
    // Unknown appId: don't deadlock — the caller will surface its own
    // "unknown app" UX.
    if (!app) return { ready: true, reason: "ready" };
    if (accessLoading) return { ready: false, reason: "access" };
  }

  return { ready: true, reason: "ready" };
}
