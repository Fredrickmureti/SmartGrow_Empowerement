import { Outlet } from "react-router-dom";
import { AdminProtectedRoute } from "@/components/auth/AdminProtectedRoute";
import { AdminDashboardLayout } from "./AdminDashboardLayout";

/**
 * Shared layout route for all admin pages.
 * Wraps AdminProtectedRoute + AdminDashboardLayout once,
 * so auth/MFA checks and sidebar state persist across navigation.
 */
export function AdminLayoutRoute() {
  return (
    <AdminProtectedRoute>
      <AdminDashboardLayout>
        <Outlet />
      </AdminDashboardLayout>
    </AdminProtectedRoute>
  );
}
