/**
 * Platform (Settings / Workspace) nav — the home of every cross-app
 * configuration surface that used to live under the legacy DashboardLayout.
 *
 * Operations: day-to-day workspace surfaces (Home, Team, Notifications).
 * Apps:       marketplace + per-app setup.
 * Company:    books-level configuration (company, carriers, migration, scanner, subscriptions).
 * Workspace:  personal workspace chrome (profile, appearance, security, …).
 * Insights:   cross-cutting audit/compliance/consolidation reports.
 * Billing:    plan + invoice history.
 */
import {
  Settings,
  Users,
  Bell,
  LayoutGrid,
  Wrench,
  Building2,
  Truck,
  GitCompare,
  ScanLine,
  Package,
  Cpu,
  UserCog,
  History,

  ShieldCheck,
  FileBarChart2,
  Sparkles,
  Receipt,
} from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const PLATFORM_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/settings",      label: "Settings",      icon: Settings, end: true },
        { to: "/team",          label: "Team",          icon: Users },
        { to: "/notifications", label: "Notifications", icon: Bell },
      ],
    },
    {
      label: "Apps",
      items: [
        { to: "/apps",       label: "Marketplace", icon: LayoutGrid, end: true },
        { to: "/apps/setup", label: "App Setup",   icon: Wrench },
      ],
    },
    {
      label: "Company",
      items: [
        { to: "/settings/company",   label: "Company",          icon: Building2 },
        { to: "/settings/carriers",  label: "Carriers",         icon: Truck },
        { to: "/settings/migration", label: "Data Migration",   icon: GitCompare },
        { to: "/settings/scanner",   label: "Scanner",          icon: ScanLine },
        { to: "/platform/hardware/devices", label: "Hardware Devices", icon: Cpu },
        { to: "/settings/apps",      label: "Subscriptions",    icon: Package },
      ],
    },

    {
      label: "Workspace",
      items: [
        { to: "/settings/workspace", label: "Workspace", icon: UserCog },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/settings/audit-logs",   label: "Audit Logs",    icon: History },
        { to: "/compliance",            label: "Compliance",    icon: ShieldCheck },
        // Cross-company comparative P&L now lives in Finance reporting
        // (/finance/reports/cross-company) — it is a financial report, not a setting.

      ],
    },
    {
      label: "Billing",
      items: [
        { to: "/upgrade", label: "Upgrade",         icon: Sparkles },
        { to: "/billing", label: "Billing History", icon: Receipt },
      ],
    },
  ],
};
