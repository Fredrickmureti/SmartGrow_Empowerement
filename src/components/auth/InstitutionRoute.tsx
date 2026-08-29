import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { BoundedLoader } from "@/components/common/BoundedLoader";
import { WorkspaceRecoveryCard } from "@/components/common/WorkspaceRecoveryCard";
import { NoWorkspaceEmptyState } from "@/components/common/NoWorkspaceEmptyState";
import { useWorkspaceRouting } from "@/hooks/useWorkspaceRouting";

interface InstitutionRouteProps {
  children: React.ReactNode;
  /**
   * Legacy SaaS entitlement key. Accepted so existing call sites keep
   * compiling during the microfinance convergence; it has no effect —
   * this is a single-institution deployment with no subscription tiers.
   */
  requiredFeature?: string;
  /** Legacy no-op, kept for the same reason as `requiredFeature`. */
  allowReadOnly?: boolean;
}

/**
 * InstitutionRoute — the authenticated gate for the single-institution
 * microfinance workspace.
 *
 * This replaces the former `SubscriptionProtectedRoute`. Entitlement,
 * trial, suspension and plan-feature gating were SaaS concerns and are
 * gone; what remains is authentication, portal/internal boundary
 * enforcement and workspace readiness.
 */
export function InstitutionRoute({ children }: InstitutionRouteProps) {
  const { user } = useAuth();
  const { currentOrg, userType } = useSession();
  const location = useLocation();
  const routing = useWorkspaceRouting();

  if (routing.status === "loading") {
    return <BrandedLoader message="Loading..." />;
  }

  if (routing.status === "unauthenticated") {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Portal (self-service) users may only reach their own surfaces.
  if (userType === "portal") {
    const PORTAL_SAFE_PREFIXES = ["/me", "/settings", "/notifications"];
    const isPortalSafe = PORTAL_SAFE_PREFIXES.some(
      (prefix) => location.pathname === prefix || location.pathname.startsWith(prefix + "/"),
    );
    if (!isPortalSafe) {
      return <Navigate to="/dashboard" replace />;
    }
    return <>{children}</>;
  }

  if (routing.status === "no-orgs" || routing.status === "needs-onboarding") {
    const onboardingCompleted = user.user_metadata?.onboarding_completed === true;
    return <NoWorkspaceEmptyState onboardingCompleted={onboardingCompleted} />;
  }

  if (!currentOrg) {
    return (
      <BoundedLoader
        message="Loading your workspace..."
        timeoutMs={12_000}
        recovery={<WorkspaceRecoveryCard />}
      />
    );
  }

  return <>{children}</>;
}
