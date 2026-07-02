import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "@/contexts/SessionContext";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { getAppByPath } from "@/lib/apps/registry";

interface InternalOnlyRouteProps {
  children: React.ReactNode;
}

/**
 * InternalOnlyRoute — Automatically blocks portal users from apps
 * marked with `internalOnly: true` in the app registry.
 *
 * This provides a safety net on top of PortalUserRoute: even if a
 * developer forgets to wrap a route in PortalUserRoute, any app
 * flagged as internalOnly will still be blocked for portal users.
 *
 * Enforces Odoo's design: business apps (Finance, Sales, Purchases,
 * Inventory, POS, CRM, etc.) are never accessible to portal users.
 */
export function InternalOnlyRoute({ children }: InternalOnlyRouteProps) {
  const { userType, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) {
    return <BrandedLoader message="Loading..." />;
  }

  // Only gate portal users
  if (userType !== "portal") {
    return <>{children}</>;
  }

  // Check if the current path belongs to an internal-only app
  const app = getAppByPath(location.pathname);
  if (app?.internalOnly) {
    console.log(
      "[InternalOnlyRoute] Portal user blocked from internal-only app:",
      app.id,
      "→ redirecting to /me"
    );
    return <Navigate to="/me" replace />;
  }

  return <>{children}</>;
}
