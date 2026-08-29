/**
 * ProtectedRoute — guards tenant routes.
 *
 * Authentication gate plus the AAL2 (2FA) challenge. The SaaS platform-admin
 * persona was removed by the microfinance convergence.
 */
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { MfaChallengeGate } from "@/components/auth/MfaChallengeGate";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <BrandedLoader message="Authenticating..." />;
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Enforce AAL2 whenever the user has a verified TOTP factor. Invisible
  // for tenants without 2FA enrolled.
  return <MfaChallengeGate>{children}</MfaChallengeGate>;
}
