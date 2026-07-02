import { ReactNode } from "react";
import { usePermissions } from "@/hooks/usePermissions";
import { Permission } from "@/lib/permissions";

interface PermissionGateProps {
  children: ReactNode;
  permission?: Permission;
  permissions?: Permission[];
  requireAll?: boolean;
  fallback?: ReactNode;
}

/**
 * A component that conditionally renders children based on user permissions.
 * 
 * @param permission - Single permission to check
 * @param permissions - Array of permissions to check
 * @param requireAll - If true, requires all permissions; if false (default), requires any
 * @param fallback - Content to render if permission check fails
 */
export function PermissionGate({ 
  children, 
  permission,
  permissions,
  requireAll = false,
  fallback = null 
}: PermissionGateProps) {
  const { can, canAny, canAll } = usePermissions();

  let hasAccess = false;

  if (permission) {
    hasAccess = can(permission);
  } else if (permissions && permissions.length > 0) {
    hasAccess = requireAll ? canAll(permissions) : canAny(permissions);
  } else {
    // No permission specified, allow access
    hasAccess = true;
  }

  if (!hasAccess) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}

/**
 * Hook to check if user can edit (has manage permission for a feature)
 * Returns true if user can edit, false if read-only
 */
export function useCanEdit(feature: "contacts" | "products" | "sales" | "purchases" | "financials" | "settings" | "team"): boolean {
  const permissions = usePermissions();

  switch (feature) {
    case "contacts":
      return permissions.canManageContacts;
    case "products":
      return permissions.canManageProducts;
    case "sales":
      return permissions.canManageSales;
    case "purchases":
      return permissions.canManagePurchases;
    case "financials":
      return permissions.canManageFinancials;
    case "settings":
      return permissions.canEditSettings;
    case "team":
      return permissions.canManageTeam;
    default:
      return false;
  }
}
