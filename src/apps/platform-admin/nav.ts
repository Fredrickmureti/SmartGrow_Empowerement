/**
 * Platform Admin workspace navigation.
 *
 * Structural counterpart to `src/apps/<app>/nav.ts` for tenant apps.
 * Same groups → items shape as `WorkspaceNav` so the admin sidebar
 * and tenant sidebar consume a single conceptual contract; the type
 * is admin-specific only because admin uses platform-permission
 * strings ("analytics.view", "plans.manage", …) that live outside
 * the tenant `Permission` union.
 *
 * This file is the source of truth for the admin console's left
 * navigation. `PlatformAdminAppLayout` accepts it as a prop the same
 * way `PlatformShell` accepts `WorkspaceNav`, so future work can
 * migrate the visual shell without touching this data.
 */
import {
  LayoutDashboard,
  Building2,
  Users,
  TrendingUp,
  Settings,
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
  type LucideIcon,
} from "lucide-react";

export interface AdminWorkspaceNavItem {
  /** Absolute route, e.g. "/admin-management/users". */
  to: string;
  label: string;
  icon?: LucideIcon;
  /** Match exactly (e.g. dashboard root). Defaults to false. */
  end?: boolean;
  /** Platform permission keys — user needs at least one to see this item. */
  permissions?: string[];
}

export interface AdminWorkspaceNavGroup {
  /** Short label, e.g. "Command Center". */
  label: string;
  items: AdminWorkspaceNavItem[];
}

export interface AdminWorkspaceNav {
  groups: AdminWorkspaceNavGroup[];
}

export const PLATFORM_ADMIN_NAV: AdminWorkspaceNav = {
  groups: [
    {
      label: "Command Center",
      items: [
        { to: "/admin-management", label: "Dashboard", icon: LayoutDashboard, end: true },
        { to: "/admin-management/analytics", label: "Analytics", icon: TrendingUp, permissions: ["analytics.view"] },
        { to: "/admin-management/reports", label: "Reports", icon: BarChart3, permissions: ["reports.view"] },
      ],
    },
    {
      label: "Commercial",
      items: [
        { to: "/admin-management/plan-builder", label: "Plan Builder", icon: CreditCard, permissions: ["plans.manage"] },
        { to: "/admin-management/app-catalog", label: "App Catalog", icon: LayoutDashboard, permissions: ["plans.manage"] },
        { to: "/admin-management/organizations", label: "Organizations", icon: Building2, permissions: ["organizations.view"] },
        { to: "/admin-management/users", label: "Users", icon: Users, permissions: ["users.view"] },
        { to: "/admin-management/payments", label: "Revenue & Billing", icon: Wallet, permissions: ["billing.view"] },
      ],
    },
    {
      label: "Infrastructure",
      items: [
        { to: "/admin-management/email-center", label: "Email Center", icon: Mail, permissions: ["email.manage"] },
        { to: "/admin-management/infrastructure", label: "Providers", icon: Server, permissions: ["infrastructure.manage"] },
      ],
    },
    {
      label: "Platform",
      items: [
        { to: "/admin-management/settings", label: "Settings", icon: Settings, permissions: ["settings.view"] },
        { to: "/admin-management/audit-log", label: "Audit Log", icon: ClipboardList, permissions: ["audit_log.view"] },
        { to: "/admin-management/localization-packs", label: "Localization", icon: Globe, permissions: ["localization.manage"] },
        { to: "/admin-management/demo-requests", label: "Demo Requests", icon: CalendarCheck, permissions: ["demo_requests.manage"] },
      ],
    },
    {
      label: "Team & Access",
      items: [
        { to: "/admin-management/team", label: "Team", icon: UsersRound, permissions: ["team.view"] },
        { to: "/admin-management/groups", label: "Groups", icon: FolderKey, permissions: ["team.manage"] },
      ],
    },
  ],
};

export function findAdminCrumb(
  pathname: string,
  nav: AdminWorkspaceNav = PLATFORM_ADMIN_NAV,
): AdminWorkspaceNavItem | null {
  const flat = nav.groups.flatMap((g) => g.items);
  let best: AdminWorkspaceNavItem | null = null;
  for (const item of flat) {
    const match = item.end ? pathname === item.to : pathname.startsWith(item.to);
    if (match && (!best || item.to.length > best.to.length)) best = item;
  }
  return best;
}
