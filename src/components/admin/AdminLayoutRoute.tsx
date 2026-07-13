import { Outlet } from "react-router-dom";
import { AdminProtectedRoute } from "@/components/auth/AdminProtectedRoute";
import { PlatformAdminAppLayout } from "@/apps/platform-admin/PlatformAdminAppLayout";

/**
 * Shared layout route for all admin pages.
 * Wraps AdminProtectedRoute + PlatformAdminAppLayout once,
 * so auth/MFA checks and sidebar state persist across navigation.
 */
export function AdminLayoutRoute() {
  return (
    <AdminProtectedRoute>
      <PlatformAdminAppLayout>
        <Outlet />
      </PlatformAdminAppLayout>
    </AdminProtectedRoute>
  );
}
