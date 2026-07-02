import { Link, useLocation } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { NavLink } from "@/components/NavLink";
import {
  LayoutDashboard,
  Building2,
  Users,
  TrendingUp,
  Settings,
  Shield,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Mail,
  CalendarCheck,
  Globe,
  CreditCard,
  Server,
  Wallet,
  ClipboardList,
  BarChart3,
  UsersRound,
  FolderKey,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { usePlatformPermissions } from "@/hooks/usePlatformPermissions";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { signOutAndRedirect } from "@/lib/auth/signOutAndRedirect";

interface NavItem {
  title: string;
  url: string;
  icon: any;
  /** Permission keys — user needs at least one to see this item */
  permissions?: string[];
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const adminNavSections: NavSection[] = [
  {
    label: "Command Center",
    items: [
      { title: "Dashboard", url: "/admin-management", icon: LayoutDashboard },
      { title: "Analytics", url: "/admin-management/analytics", icon: TrendingUp, permissions: ["analytics.view"] },
      { title: "Reports", url: "/admin-management/reports", icon: BarChart3, permissions: ["reports.view"] },
    ],
  },
  {
    label: "Commercial",
    items: [
      { title: "Plan Builder", url: "/admin-management/plan-builder", icon: CreditCard, permissions: ["plans.manage"] },
      { title: "App Catalog", url: "/admin-management/app-catalog", icon: LayoutDashboard, permissions: ["plans.manage"] },
      { title: "Organizations", url: "/admin-management/organizations", icon: Building2, permissions: ["organizations.view"] },
      { title: "Users", url: "/admin-management/users", icon: Users, permissions: ["users.view"] },
      { title: "Revenue & Billing", url: "/admin-management/payments", icon: Wallet, permissions: ["billing.view"] },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { title: "Email Center", url: "/admin-management/email-center", icon: Mail, permissions: ["email.manage"] },
      { title: "Providers", url: "/admin-management/infrastructure", icon: Server, permissions: ["infrastructure.manage"] },
    ],
  },
  {
    label: "Platform",
    items: [
      { title: "Settings", url: "/admin-management/settings", icon: Settings, permissions: ["settings.view"] },
      { title: "Audit Log", url: "/admin-management/audit-log", icon: ClipboardList, permissions: ["audit_log.view"] },
      { title: "Localization", url: "/admin-management/localization-packs", icon: Globe, permissions: ["localization.manage"] },
      { title: "Demo Requests", url: "/admin-management/demo-requests", icon: CalendarCheck, permissions: ["demo_requests.manage"] },
    ],
  },
  {
    label: "Team & Access",
    items: [
      { title: "Team", url: "/admin-management/team", icon: UsersRound, permissions: ["team.view"] },
      { title: "Groups", url: "/admin-management/groups", icon: FolderKey, permissions: ["team.manage"] },
    ],
  },
];

export function AdminSidebar() {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const { hasPerm, hasAnyPerm, isOwner } = usePlatformPermissions();
  const { organizations } = useOrganization();
  const { signOut } = useAuth();
  // Pure platform admins (no tenant workspace under this email) get a
  // "Sign out" footer instead of the tenant "Back to App" link. Big-system
  // pattern (Xero Practice, Odoo SaaS): never show tenant-app navigation
  // to a SaaS operator who doesn't run a tenant.
  const hasTenantWorkspace = organizations.length > 0;

  // Filter sections and items based on permissions
  const visibleSections = adminNavSections
    .map(section => ({
      ...section,
      items: section.items.filter(item => {
        // No permissions required = always visible (e.g. Dashboard)
        if (!item.permissions || item.permissions.length === 0) return true;
        // Owner sees everything
        if (isOwner) return true;
        // Check if user has any of the required permissions
        return hasAnyPerm(item.permissions);
      }),
    }))
    .filter(section => section.items.length > 0);

  return (
    <Sidebar
      className={`border-r transition-all duration-300 ${
        collapsed ? "w-16" : "w-64"
      }`}
      collapsible="icon"
    >
      <SidebarHeader className="border-b p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center flex-shrink-0">
              <Shield className="h-5 w-5 text-primary-foreground" />
            </div>
            {!collapsed && (
              <div className="overflow-hidden">
                <h2 className="font-semibold text-sm">Admin Console</h2>
                <p className="text-xs text-muted-foreground">Platform Control</p>
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 flex-shrink-0"
            onClick={toggleSidebar}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {visibleSections.map((section, sIdx) => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel className={collapsed ? "sr-only" : "text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold"}>
              {section.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
                  const isActive = location.pathname === item.url ||
                    (item.url !== "/admin-management" && location.pathname.startsWith(item.url));
                  return (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        tooltip={collapsed ? item.title : undefined}
                      >
                        <NavLink
                          to={item.url}
                          end={item.url === "/admin-management"}
                          className="flex items-center gap-3"
                          activeClassName="bg-primary/10 text-primary font-medium"
                        >
                          <item.icon className="h-4 w-4 flex-shrink-0" />
                          {!collapsed && <span className="text-sm">{item.title}</span>}
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
            {sIdx < visibleSections.length - 1 && !collapsed && (
              <Separator className="my-1 mx-2" />
            )}
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t p-4 space-y-2">
        {hasTenantWorkspace ? (
          <Button
            variant="outline"
            size={collapsed ? "icon" : "sm"}
            className="w-full bg-transparent border-sidebar-border text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            asChild
          >
            <Link to="/dashboard">
              <ArrowLeft className={`h-4 w-4 ${collapsed ? "" : "mr-2"}`} />
              {!collapsed && "Back to App"}
            </Link>
          </Button>
        ) : (
          // Pure platform-admin account (no tenant workspace under this email).
          // Big-system pattern (Xero Practice Manager, Odoo SaaS): hide
          // tenant-app navigation entirely. Offer only "Sign out" so the
          // operator can switch to a different account if needed.
          <Button
            variant="outline"
            size={collapsed ? "icon" : "sm"}
            className="w-full bg-transparent border-sidebar-border text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={() => {
              // Persona-aware: pure platform admins go back to the
              // operator login screen, not the tenant /login.
              signOutAndRedirect(signOut, window.location.pathname);
            }}
            title={collapsed ? "Sign out" : undefined}
          >
            <ArrowLeft className={`h-4 w-4 ${collapsed ? "" : "mr-2"}`} />
            {!collapsed && "Sign out"}
          </Button>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
