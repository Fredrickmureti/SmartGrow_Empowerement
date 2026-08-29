/**
 * Shared guard helpers for the HR domain (Employees only in the
 * microfinance scope).
 *
 * Centralised so each sub-app's routes file stays focused on its own domain.
 */

import { ReactNode, Suspense } from "react";
import { Navigate } from "react-router-dom";
import { RouteLoadingFallback } from "@/components/common/RouteLoadingFallback";
import { InstitutionRoute } from "@/components/auth/InstitutionRoute";
import { useSession } from "@/contexts/SessionContext";
import { usePermissions } from "@/hooks/usePermissions";

/**
 * Portal users bypass subscription feature-gating for self-service routes,
 * which they reach as identity self-service rather than as paid modules.
 */
export function PortalOrSubscriptionGate({ children }: { children: ReactNode }) {
  const { userType } = useSession();
  if (userType === "portal") return <>{children}</>;
  return <InstitutionRoute allowReadOnly>{children}</InstitutionRoute>;
}

/**
 * Standard Suspense wrapper used by every HR-domain route.
 */
export function LazyRoute({
  children,
  module,
}: {
  children: ReactNode;
  module?: string;
}) {
  return <Suspense fallback={<RouteLoadingFallback module={module} />}>{children}</Suspense>;
}

/**
 * Smart redirect for /hr root and unknown /hr paths:
 * - portal users → /me
 * - employees-app users → /hr/employees
 * - everyone else → /me (self-service fallback)
 */
export function HRCatchAllRedirect() {
  const { userType } = useSession();
  const { can } = usePermissions();

  if (userType === "portal") return <Navigate to="/me" replace />;
  if (can("viewEmployees")) return <Navigate to="/hr/employees" replace />;
  return <Navigate to="/me" replace />;
}
