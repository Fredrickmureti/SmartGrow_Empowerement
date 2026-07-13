/**
 * AdminSidebarBody — grouped nav rendered inside the desktop aside
 * and the mobile Sheet. Mirrors the tenant SidebarBody pattern.
 */
import { NavLink } from "react-router-dom";
import { Link } from "react-router-dom";
import { Shield, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePlatformPermissions } from "@/hooks/usePlatformPermissions";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { signOutAndRedirect } from "@/lib/auth/signOutAndRedirect";
import {
  PLATFORM_ADMIN_NAV,
  type AdminWorkspaceNav,
  type AdminWorkspaceNavItem,
} from "@/apps/platform-admin/nav";

interface Props {
  collapsed?: boolean;
  onNavigate?: () => void;
}

function Item({ item, collapsed, onNavigate }: { item: AdminNavItem; collapsed: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
          isActive
            ? "bg-primary/10 text-primary font-medium"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
          collapsed && "justify-center px-0",
        )
      }
    >
      {Icon && <Icon className="h-4 w-4 shrink-0" />}
      {!collapsed && <span className="truncate flex-1">{item.label}</span>}
    </NavLink>
  );
}

export function AdminSidebarBody({ collapsed = false, onNavigate }: Props) {
  const { hasAnyPerm, isOwner } = usePlatformPermissions();
  const { organizations } = useOrganization();
  const { signOut } = useAuth();
  // Pure platform admins (no tenant workspace under this email) get a
  // "Sign out" footer instead of the tenant "Back to App" link.
  const hasTenantWorkspace = organizations.length > 0;

  const visibleGroups = ADMIN_NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => {
      if (!i.permissions?.length) return true;
      if (isOwner) return true;
      return hasAnyPerm(i.permissions);
    }),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <div
        className={cn(
          "flex items-center h-12 border-b border-border shrink-0",
          collapsed ? "justify-center px-1" : "gap-2 px-3",
        )}
      >
        <div className="h-7 w-7 rounded-md bg-primary flex items-center justify-center shrink-0">
          <Shield className="h-4 w-4 text-primary-foreground" />
        </div>
        {!collapsed && (
          <span className="text-sm font-semibold truncate flex-1">Admin Console</span>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {visibleGroups.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="px-2 pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/70 font-medium">
                {group.label}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <Item key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-2 shrink-0">
        {hasTenantWorkspace ? (
          <Button
            variant="ghost"
            size="sm"
            asChild
            className={cn("w-full text-muted-foreground hover:text-foreground", collapsed && "px-0")}
          >
            <Link to="/dashboard" onClick={onNavigate} title={collapsed ? "Back to App" : undefined}>
              <ArrowLeft className={cn("h-4 w-4", !collapsed && "mr-2")} />
              {!collapsed && "Back to App"}
            </Link>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOutAndRedirect(signOut, window.location.pathname)}
            title={collapsed ? "Sign out" : undefined}
            className={cn("w-full text-muted-foreground hover:text-foreground", collapsed && "px-0")}
          >
            <ArrowLeft className={cn("h-4 w-4", !collapsed && "mr-2")} />
            {!collapsed && "Sign out"}
          </Button>
        )}
      </div>
    </>
  );
}
