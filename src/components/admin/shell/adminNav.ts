/**
 * Admin workspace navigation config.
 *
 * Mirrors the tenant WorkspaceNav shape (groups → items) so the
 * admin sidebar / topbar breadcrumb read from a single source of
 * truth — the same approach the tenant apps use.
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

export interface AdminNavItem {
  to: string;
  label: string;
  icon?: LucideIcon;
  end?: boolean;
  /** Platform permission keys — user needs at least one to see this item. */
  permissions?: string[];
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV: AdminNavGroup[] = [
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
];

export function findAdminCrumb(pathname: string): AdminNavItem | null {
  const flat = ADMIN_NAV.flatMap((g) => g.items);
  let best: AdminNavItem | null = null;
  for (const item of flat) {
    const match = item.end ? pathname === item.to : pathname.startsWith(item.to);
    if (match && (!best || item.to.length > best.to.length)) best = item;
  }
  return best;
}
