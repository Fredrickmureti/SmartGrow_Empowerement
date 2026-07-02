/**
 * Route-level guard that ensures a Company is selected before rendering
 * the wrapped element. Used for standalone routes that intentionally bypass
 * an app workspace layout (e.g. the full-screen POS terminal) but still need
 * the active-business contract enforced.
 */
import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";

interface RequireActiveBusinessRouteProps {
  children: ReactNode;
  /** Where to send users who have no active company. */
  redirectTo?: string;
}

export function RequireActiveBusinessRoute({
  children,
  redirectTo = "/setup/company",
}: RequireActiveBusinessRouteProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness, isLoading } = useBusinesses();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading workspace…</div>
      </div>
    );
  }

  if (!currentOrg || !currentBusiness) {
    return <Navigate to={redirectTo} replace />;
  }

  return <>{children}</>;
}

export default RequireActiveBusinessRoute;
