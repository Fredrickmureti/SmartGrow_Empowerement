import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { BrandedLoader } from "@/components/common/BrandedLoader";

interface NonVendorRouteProps {
  children: React.ReactNode;
}

/**
 * NonVendorRoute - Blocks vendor portal users from accessing admin/dashboard routes.
 * If the current user has `is_vendor_portal: true` in their metadata,
 * they are redirected to `/vendor-portal`.
 * 
 * This is the Odoo-style "portal gate" — vendor users can NEVER access /web (backend).
 */
export function NonVendorRoute({ children }: NonVendorRouteProps) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <BrandedLoader message="Loading..." />;
  }

  // Not logged in — let ProtectedRoute / InstitutionRoute handle redirect
  if (!user) {
    return <>{children}</>;
  }

  // Vendor portal user → redirect away from admin routes
  if (user.user_metadata?.is_vendor_portal === true) {
    console.log("[NonVendorRoute] Vendor user blocked from admin route, redirecting to /vendor-portal");
    return <Navigate to="/vendor-portal" replace />;
  }

  return <>{children}</>;
}
