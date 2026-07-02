import { ReactNode } from "react";
import { usePlatformPermissions } from "@/hooks/usePlatformPermissions";

interface PlatformPermissionGateProps {
  children: ReactNode;
  permission?: string;
  permissions?: string[];
  requireAll?: boolean;
  /** What to render when access is denied (default: nothing) */
  fallback?: ReactNode;
  /** If true, owner always passes regardless of permission */
  ownerOnly?: boolean;
}

/**
 * Conditionally renders children based on platform admin permissions.
 * Owner always has access to everything.
 */
export function PlatformPermissionGate({
  children,
  permission,
  permissions,
  requireAll = false,
  fallback = null,
  ownerOnly = false,
}: PlatformPermissionGateProps) {
  const { hasPerm, hasAnyPerm, isOwner, isLoading } = usePlatformPermissions();

  if (isLoading) return null;

  // Owner-only gate
  if (ownerOnly) {
    return isOwner ? <>{children}</> : <>{fallback}</>;
  }

  // Single permission check
  if (permission) {
    return hasPerm(permission) ? <>{children}</> : <>{fallback}</>;
  }

  // Multiple permissions check
  if (permissions && permissions.length > 0) {
    const hasAccess = requireAll
      ? permissions.every(p => hasPerm(p))
      : hasAnyPerm(permissions);
    return hasAccess ? <>{children}</> : <>{fallback}</>;
  }

  // No permission specified = render children
  return <>{children}</>;
}
