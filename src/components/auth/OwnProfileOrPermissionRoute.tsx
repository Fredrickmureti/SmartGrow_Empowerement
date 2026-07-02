import { Navigate, useParams } from "react-router-dom";
import { usePermissions } from "@/hooks/usePermissions";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { Permission } from "@/lib/permissions";
import { Loader2 } from "lucide-react";

interface OwnProfileOrPermissionRouteProps {
  children: React.ReactNode;
  permission: Permission;
  fallbackPath?: string;
}

/**
 * Allows access if user has the permission OR is viewing their own employee profile.
 * Used for /hr/employees/:id — HR staff can view anyone, others can only view themselves.
 */
export function OwnProfileOrPermissionRoute({
  children,
  permission,
  fallbackPath = "/hr/my-portal",
}: OwnProfileOrPermissionRouteProps) {
  const { id } = useParams<{ id: string }>();
  const { can } = usePermissions();
  const { currentEmployee, isLoading } = useCurrentEmployee();

  // If user has the full permission, allow access
  if (can(permission)) {
    return <>{children}</>;
  }

  // Wait for employee data to determine own profile
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Allow if viewing own profile
  if (currentEmployee && currentEmployee.id === id) {
    return <>{children}</>;
  }

  return <Navigate to={fallbackPath} replace />;
}
