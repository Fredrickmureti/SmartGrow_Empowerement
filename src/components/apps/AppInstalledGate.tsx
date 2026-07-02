/**
 * AppInstalledGate — route guard that enforces app installation.
 *
 * Wrap any non-platform app's route subtree with this. If the app is
 * not installed for the current org, the user is redirected to
 * `/apps/{appId}/activate` (which renders the proper install / trial /
 * subscribe / coming-soon flow via `useAppLifecycle`) instead of being
 * dropped into an empty workspace and *then* asked to install.
 *
 * CRITICAL: the redirect MUST only fire against authoritative state.
 * We use `useWorkspaceContextReady` as the single readiness predicate
 * — it conjuncts auth, session, org, business, platform-apps catalog,
 * the installed-apps query, and per-app access. While `!ready`, the
 * gate renders a branded loader; the install-decision branch is
 * unreachable until every dependency has resolved.
 *
 * See `.lovable/plan.md` (Workspace install-state hydration) for the
 * RCA of the symptom this guards against ("Install POS" shown to a
 * tenant who already has POS installed).
 */
import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useAppAccess } from "@/hooks/useAppAccess";
import { useWorkspaceContextReady } from "@/hooks/useWorkspaceContextReady";
import { getAppById } from "@/lib/apps/registry";

interface AppInstalledGateProps {
  /** App ID — must exist in APP_REGISTRY. */
  appId: string;
  children: ReactNode;
}

export function AppInstalledGate({ appId, children }: AppInstalledGateProps) {
  const { user } = useAuth();
  const { userType, currentOrg } = useSession();
  const { isInstalled, isReady: installedAppsReady } = useInstalledApps();
  const { getAppEntitlementState } = useAppAccess();
  const { ready, reason } = useWorkspaceContextReady({ appId });
  const location = useLocation();

  // While the workspace context is still hydrating, NEVER paint the
  // "not installed" branch. This is the single line that closes the
  // hydration race.
  if (!ready) {
    return <BrandedLoader message="Loading workspace..." />;
  }

  // Anonymous users — defer to the auth layer above this gate.
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Portal (employee self-service) users use a different gating model.
  if (userType === "portal") return <>{children}</>;

  const app = getAppById(appId);

  // Unknown appId — fail open with a friendly redirect rather than crash.
  if (!app) return <Navigate to="/apps" replace />;

  // Settings/platform apps are always considered installed.
  if (app.isPlatform) return <>{children}</>;

  // No org context yet — `ready` already covered this, but keep the
  // defensive check so the type system knows currentOrg is defined.
  if (!currentOrg) return <BrandedLoader message="Loading organization..." />;

  // Odoo-style trial enforcement: even if the install row is technically
  // present (e.g. cron has not yet run on this exact second), an expired
  // trial without other entitlement must NOT enter the workspace.
  if (getAppEntitlementState(app.id) === "expired_trial") {
    return <Navigate to={`/apps/${app.id}/activate`} replace />;
  }

  if (isInstalled(app.id)) return <>{children}</>;

  // Observability: if we are about to send a user to the activate
  // page, log a structured breadcrumb. The next time someone reports
  // "POS keeps asking me to install" we have a one-shot diagnosis.
  if (typeof console !== "undefined") {
    console.warn("[AppInstalledGate] redirecting to activate", {
      appId: app.id,
      orgId: currentOrg.id,
      installedAppsReady,
      readinessReason: reason,
      pathname: location.pathname,
    });
  }

  // Not installed — send to the activate page. `replace: true` so the
  // back button doesn't bounce the user back into the empty workspace.
  return <Navigate to={`/apps/${app.id}/activate`} replace />;
}
