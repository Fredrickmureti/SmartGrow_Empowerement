import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { BoundedLoader } from "@/components/common/BoundedLoader";
import { WorkspaceRecoveryCard } from "@/components/common/WorkspaceRecoveryCard";
import { NoWorkspaceEmptyState } from "@/components/common/NoWorkspaceEmptyState";
import { SubscriptionBlockedPage } from "./SubscriptionBlockedPage";
import { SubscriptionAccessProvider } from "@/contexts/SubscriptionAccessContext";
import { SubscriptionUpgradeModal } from "./SubscriptionUpgradeModal";
import { getAppByPath } from "@/lib/apps/registry";
import { useWorkspaceRouting } from "@/hooks/useWorkspaceRouting";

interface SubscriptionProtectedRouteProps {
  children: React.ReactNode;
  requiredFeature?: string;
  /** If true, allows viewing the page in read-only mode instead of blocking completely */
  allowReadOnly?: boolean;
}

/**
 * SubscriptionProtectedRoute v3 — readiness decisions delegated to
 * `useWorkspaceRouting`. This component only renders. The selector
 * eliminates the per-guard `authLoading || sessionLoading || (user && !sessionReady)`
 * combinations that previously raced and could flash
 * `/select-organization?returnTo=…` on reload.
 */
export function SubscriptionProtectedRoute({
  children,
  requiredFeature,
  allowReadOnly = false,
}: SubscriptionProtectedRouteProps) {
  const { user } = useAuth();
  const {
    subscriptionStatus,
    hasEntitlement,
    currentOrg,
    userType,
  } = useSession();
  const location = useLocation();
  const routing = useWorkspaceRouting();

  // Steady-state readiness from the canonical selector.
  if (routing.status === "loading") {
    return <BrandedLoader message="Loading..." />;
  }

  // Unauthenticated → login. The selector reports this; we don't sniff
  // `user` ourselves to keep the source-of-truth single.
  if (routing.status === "unauthenticated") {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Vendor portal users must NEVER access admin routes
  if (user.user_metadata?.is_vendor_portal === true) {
    return <Navigate to="/vendor-portal" replace />;
  }

  // Portal (employee) users bypass subscription gating — their self-service
  // portal should always be accessible regardless of subscription status.
  // BUT: enforce the hard portal/internal boundary here as a safety net.
  // Portal users can ONLY access self-service routes, never business routes.
  if (userType === "portal") {
    const PORTAL_SAFE_PREFIXES = [
      "/hr/my-portal", "/hr/leave", "/hr/timesheets", "/hr/documents",
      "/settings", "/settings/profile", "/select-organization", "/notifications", "/upgrade",
    ];
    const isPortalSafe = PORTAL_SAFE_PREFIXES.some(
      (prefix) => location.pathname === prefix || location.pathname.startsWith(prefix + "/")
    );
    
    if (!isPortalSafe) {
      // Check if it's an internal-only app route
      const app = getAppByPath(location.pathname);
      if (app?.internalOnly) {
        console.log(
          "[SubscriptionProtectedRoute] Portal user blocked from internal-only app:",
          app.id,
          "→ redirecting to /dashboard"
        );
        return <Navigate to="/dashboard" replace />;
      }
      
      // Also block known business legacy routes that aren't under an app basePath
      const BUSINESS_ROUTE_PREFIXES = [
        "/estimates", "/bills", "/purchase-orders", "/credit-notes",
        "/recurring-invoices", "/banking", "/bank-reconciliation", "/bank-feeds",
        "/proforma-invoices", "/sales-orders", "/delivery-notes", "/sales-returns",
        "/purchase-returns", "/reports/", "/fiscal-periods", "/inventory",
        "/employees", "/payroll", "/fixed-assets", "/warehouses", "/journal-entries",
        "/audit-logs", "/customer-statements", "/budgets", "/business-intelligence",
        "/pos", "/crm", "/projects", "/timesheets", "/leave", "/departments",
        "/studio", "/compliance", "/sign", "/spreadsheets",
      ];
      const isBusinessRoute = BUSINESS_ROUTE_PREFIXES.some(
        (prefix) => location.pathname === prefix || location.pathname.startsWith(prefix + "/")
      );
      
      if (isBusinessRoute) {
        console.log(
          "[SubscriptionProtectedRoute] Portal user blocked from business route:",
          location.pathname,
          "→ redirecting to /dashboard"
        );
        return <Navigate to="/dashboard" replace />;
      }
    }
    
    return <>{children}</>;
  }

  // Empty-membership states from the canonical selector. We deliberately
  // do NOT <Navigate> to /select-organization here — that mutates the URL
  // synchronously and produces the "/select-organization?returnTo=…" flash
  // on reload. URL = user intent, not loading bookkeeping.
  if (routing.status === "no-orgs" || routing.status === "needs-onboarding") {
    const onboardingCompleted = user.user_metadata?.onboarding_completed === true;
    return <NoWorkspaceEmptyState onboardingCompleted={onboardingCompleted} />;
  }

  // Defensive: selector says "loading" again, or currentOrg unexpectedly
  // null after `ready`. Show the bounded loader with recovery rather than
  // redirect; the next commit resolves it.
  if (!currentOrg) {
    return (
      <BoundedLoader
        message="Loading your workspace..."
        timeoutMs={12_000}
        recovery={<WorkspaceRecoveryCard />}
      />
    );
  }

  // Check if organization is suspended - always block
  if (subscriptionStatus.isSuspended) {
    return (
      <SubscriptionBlockedPage 
        type="suspended" 
        reason={currentOrg?.suspended_reason || undefined}
      />
    );
  }

  // Check if subscription/trial is expired - always block
  if (subscriptionStatus.isExpired) {
    return (
      <SubscriptionBlockedPage 
        type="expired" 
        isTrialExpired={subscriptionStatus.isTrialing}
      />
    );
  }

  // Check feature access if required - O(1) lookup via Set
  const hasFeatureAccess = !requiredFeature || hasEntitlement(requiredFeature);
  
  if (!hasFeatureAccess) {
    // If allowReadOnly is true, show the page in read-only mode with upgrade prompts
    if (allowReadOnly) {
      return (
        <SubscriptionAccessProvider isReadOnly={true} lockedFeature={requiredFeature}>
          {children}
          <SubscriptionUpgradeModal />
        </SubscriptionAccessProvider>
      );
    }
    
    // Otherwise block completely
    return (
      <SubscriptionBlockedPage 
        type="feature_locked" 
        feature={requiredFeature}
      />
    );
  }

  // User has access - wrap in provider with full access
  return (
    <SubscriptionAccessProvider isReadOnly={false} lockedFeature={null}>
      {children}
      <SubscriptionUpgradeModal />
    </SubscriptionAccessProvider>
  );
}
