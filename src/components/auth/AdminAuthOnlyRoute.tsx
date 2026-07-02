import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import { BrandedLoader } from "@/components/common/BrandedLoader";

/**
 * Lightweight admin route guard that checks auth + platform admin status
 * but does NOT enforce MFA enrollment. Used for the MFA setup page itself.
 */
export function AdminAuthOnlyRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  const { isPlatformAdmin, isChecking } = usePlatformAdmin();
  const location = useLocation();

  if (authLoading || isChecking) {
    return <BrandedLoader message="Verifying access..." />;
  }

  if (!user) {
    return <Navigate to="/admin-management/login" state={{ from: location }} replace />;
  }

  if (!isPlatformAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
