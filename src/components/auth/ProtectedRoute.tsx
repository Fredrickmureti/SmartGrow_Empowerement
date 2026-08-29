/**
 * ProtectedRoute — guards tenant routes.
 *
 * Beyond the basic "is the user authenticated?" check, this also enforces
 * persona separation (ADR-0004): a platform admin must not see tenant pages
 * even if they happen to land on one via a stale tab or pasted link. We
 * bounce them to /admin-management instead of letting them render a
 * confusing empty tenant workspace (or worse, the onboarding wizard).
 */
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { usePlatformIdentity } from "@/contexts/PlatformIdentityContext";
import { MfaChallengeGate } from "@/components/auth/MfaChallengeGate";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();
  const { isPlatformAdmin, isChecking } = usePlatformIdentity();
  const location = useLocation();

  if (isLoading || (user && isChecking)) {
    return <BrandedLoader message="Authenticating..." />;
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (isPlatformAdmin) {
    // Platform admins do not belong on tenant routes. Send them home.
    return <Navigate to="/admin-management" replace />;
  }

  // Enforce AAL2 whenever the user has a verified TOTP factor. Invisible
  // for tenants without 2FA enrolled.
  return <MfaChallengeGate>{children}</MfaChallengeGate>;
}
