import { useMemo } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "@/contexts/SessionContext";
import { usePermissions } from "@/hooks/usePermissions";
import { BrandedLoader } from "@/components/common/BrandedLoader";

interface PortalUserRouteProps {
  children: React.ReactNode;
}

// Paths that portal users ALWAYS have access to (no permission check needed).
//
// IMPORTANT: This is the SOLE allowlist for portal users. Anything not listed
// here (and not added below via PORTAL_PERMISSION_PATHS) gets bounced to /me.
//
// Settings: portal users land on `/me/settings` — a purpose-built self-service
// settings page. The legacy `/settings/profile` is kept allowed because it's
// the generic account profile (avatar, name, phone) and is shared with
// internal users for the same purpose. The blanket `/settings` redirects to
// `/me/settings` for portal users via the Settings page itself.
// `/settings/notifications` is also allowed because notification preferences
// are a legitimate self-service capability.
//
// What's deliberately NOT here (and must not be added without RBAC review):
//   - /settings/workspace, /settings/company  → workspace/company config
//   - /settings/apps                          → app marketplace mgmt
//   - /settings/team, /settings/studio        → admin tooling
//   - /settings/audit-logs, /settings/migration, /settings/carriers,
//     /settings/scanner, /settings/compliance → admin tooling
//   - /apps, /apps/*                          → app marketplace
//   - /billing, /upgrade                      → subscription mgmt
//   - /dashboard, /home                       → business landing
const PORTAL_ALWAYS_ALLOWED = [
  "/me",
  "/me",
  "/select-organization",
  "/settings/profile",
  "/settings/notifications",
  "/notifications",
];

// Paths that become available when specific permissions are granted via Access Groups.
// IMPORTANT: Only self-service modules are listed here. Business modules (contacts,
// projects, sales, finance, etc.) are INTERNAL-ONLY and must never appear here.
// This enforces Odoo's hard boundary: portal users never access backend apps.
// Both `/me/*` and the legacy `/hr/*` self-service paths are listed so direct
// hits and old bookmarks both pass the gate before the legacy redirect fires.
const PORTAL_PERMISSION_PATHS: Array<{ path: string; permission: string }> = [
  { path: "/me/leave", permission: "viewLeave" },
  { path: "/me/timesheets", permission: "viewTimesheets" },
  { path: "/me/documents", permission: "viewEmployees" },
  { path: "/me/tax-certificates", permission: "viewEmployees" },
  { path: "/me/profile", permission: "viewEmployees" },
  { path: "/me/attendance", permission: "viewAttendance" },
  // Legacy `/hr/*` self-service paths — kept until all bookmarks expire.
  { path: "/hr/leave", permission: "viewLeave" },
  { path: "/hr/timesheets", permission: "viewTimesheets" },
  { path: "/hr/documents", permission: "viewEmployees" },
];

/**
 * PortalUserRoute — Blocks portal (employee self-service) users from
 * accessing business routes like Sales, Finance, Dashboard, etc.
 * 
 * Portal users are redirected to /hr/my-portal (their self-service hub).
 * Allowed paths are derived DYNAMICALLY from the user's effective permissions
 * (base role + Access Group grants), matching Odoo's additive portal model.
 */
export function PortalUserRoute({ children }: PortalUserRouteProps) {
  const { userType, isLoading } = useSession();
  const location = useLocation();
  const permissions = usePermissions();

  // Build dynamic allowed paths based on effective permissions
  const allowedPaths = useMemo(() => {
    const paths = [...PORTAL_ALWAYS_ALLOWED];
    for (const { path, permission } of PORTAL_PERMISSION_PATHS) {
      if (permissions.can(permission as any)) {
        paths.push(path);
      }
    }
    return paths;
  }, [permissions]);

  if (isLoading) {
    return <BrandedLoader message="Loading..." />;
  }

  // Only gate portal users
  if (userType !== "portal") {
    return <>{children}</>;
  }

  // Check if current path is allowed for portal users
  const isAllowed = allowedPaths.some(
    (path) => location.pathname === path || location.pathname.startsWith(path + "/")
  );

  if (isAllowed) {
    return <>{children}</>;
  }

  // Portal user on a business route → redirect to self-service My Workspace.
  // `/me` is always allowed above; falling back to `/dashboard` would re-trigger
  // this gate and infinite-loop.
  console.log(
    "[PortalUserRoute] Portal user blocked from",
    location.pathname,
    "→ redirecting to /me"
  );
  return <Navigate to="/me" replace />;
}
