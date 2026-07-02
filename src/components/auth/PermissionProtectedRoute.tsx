import { Navigate } from "react-router-dom";
import { usePermissions } from "@/hooks/usePermissions";
import { useSession } from "@/contexts/SessionContext";
import { Permission } from "@/lib/permissions";
import { Skeleton } from "@/components/ui/skeleton";

interface PermissionProtectedRouteProps {
  children: React.ReactNode;
  permission: Permission;
  fallbackPath?: string;
}

/**
 * Route wrapper that checks if user has required permission.
 * Shows loading skeleton until session is resolved to prevent data flicker.
 * Redirects to fallback path if user lacks permission.
 */
export function PermissionProtectedRoute({
  children,
  permission,
  fallbackPath = "/dashboard",
}: PermissionProtectedRouteProps) {
  const { can } = usePermissions();
  const { isLoading } = useSession();

  // Block rendering until permissions are fully resolved (prevents data flicker)
  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64 mt-4" />
      </div>
    );
  }

  // If user doesn't have the required permission, redirect
  if (!can(permission)) {
    return <Navigate to={fallbackPath} replace />;
  }

  return <>{children}</>;
}

interface MultiPermissionProtectedRouteProps {
  children: React.ReactNode;
  permissions: Permission[];
  requireAll?: boolean;
  fallbackPath?: string;
}

/**
 * Route wrapper that checks if user has any/all of the required permissions.
 */
export function MultiPermissionProtectedRoute({
  children,
  permissions,
  requireAll = false,
  fallbackPath = "/dashboard",
}: MultiPermissionProtectedRouteProps) {
  const { canAny, canAll } = usePermissions();
  const { isLoading } = useSession();

  // Block rendering until permissions are fully resolved
  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64 mt-4" />
      </div>
    );
  }

  const hasAccess = requireAll ? canAll(permissions) : canAny(permissions);

  if (!hasAccess) {
    return <Navigate to={fallbackPath} replace />;
  }

  return <>{children}</>;
}
