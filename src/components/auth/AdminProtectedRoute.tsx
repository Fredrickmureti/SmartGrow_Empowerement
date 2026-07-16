import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AdminInlineMfaSetup } from "@/components/admin/AdminInlineMfaSetup";
import { MfaChallengeGate } from "@/components/auth/MfaChallengeGate";
import { resolvePostLoginDestination } from "@/lib/auth/postLoginRedirect";

interface AdminProtectedRouteProps {
  children: React.ReactNode;
}

export function AdminProtectedRoute({ children }: AdminProtectedRouteProps) {
  const { user, isLoading: authLoading } = useAuth();
  const { isPlatformAdmin, isChecking } = usePlatformAdmin();
  const location = useLocation();
  const [mfaStatus, setMfaStatus] = useState<"loading" | "enrolled" | "not_enrolled">("loading");
  const [nonAdminDest, setNonAdminDest] = useState<string | null>(null);

  // Check MFA enrollment status
  useEffect(() => {
    if (!user || !isPlatformAdmin) {
      setMfaStatus("loading");
      return;
    }

    const checkMfa = async () => {
      try {
        const { data } = await supabase.auth.mfa.listFactors();
        const hasVerifiedTotp = data?.totp?.some(f => f.status === "verified");
        setMfaStatus(hasVerifiedTotp ? "enrolled" : "not_enrolled");
      } catch {
        // If MFA API fails, don't block access (graceful degradation)
        setMfaStatus("enrolled");
      }
    };

    checkMfa();
  }, [user, isPlatformAdmin]);

  // Resolve where to send a non-admin user (could be onboarding, dashboard,
  // or vendor portal) so we never bounce them to a route they can't reach.
  useEffect(() => {
    if (authLoading || isChecking) return;
    if (!user || isPlatformAdmin) {
      setNonAdminDest(null);
      return;
    }
    let cancelled = false;
    resolvePostLoginDestination({ user, intendedPath: null })
      .then((dest) => {
        if (!cancelled) setNonAdminDest(dest);
      })
      .catch(() => {
        if (!cancelled) setNonAdminDest("/dashboard");
      });
    return () => {
      cancelled = true;
    };
  }, [user, isPlatformAdmin, authLoading, isChecking]);

  if (authLoading || isChecking) {
    return <BrandedLoader message="Verifying admin access..." />;
  }

  if (!user) {
    return <Navigate to="/admin-management/login" state={{ from: location }} replace />;
  }

  if (!isPlatformAdmin) {
    // A tenant user landed on an admin route. Send them to the destination
    // their account actually qualifies for (onboarding, dashboard, or vendor
    // portal) instead of hard-coding /dashboard, which would loop for
    // not-yet-onboarded users.
    if (nonAdminDest === null) {
      return <BrandedLoader message="Redirecting..." />;
    }
    return <Navigate to={nonAdminDest} replace />;
  }

  // MFA check - show enrollment prompt if not enrolled
  if (mfaStatus === "loading") {
    return <BrandedLoader message="Checking security requirements..." />;
  }

  // Render MFA setup INLINE instead of navigating away
  // This prevents business-context side-effects from hijacking the flow
  if (mfaStatus === "not_enrolled") {
    return (
      <AdminInlineMfaSetup
        onComplete={() => setMfaStatus("enrolled")}
      />
    );
  }

  // Enrolled — challenge for AAL2 if the current session is still aal1.
  return <MfaChallengeGate>{children}</MfaChallengeGate>;
}
