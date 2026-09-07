/**
 * Platform (Settings / Workspace) nav — the home of every cross-app
 * configuration surface that used to live under the legacy DashboardLayout.
 *
 * Operations: day-to-day workspace surfaces (Home, Team, Notifications).
 * Company:    books-level configuration (company).
 * Workspace:  personal workspace chrome (profile, appearance, security, …).
 * Insights:   cross-cutting audit/compliance/consolidation reports.
 */
import {
  Settings,
  Users,
  Bell,
  Building2,
  UserCog,
  History,

  ShieldCheck,
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
      label: "Company",
      items: [
        { to: "/settings/company",   label: "Company",          icon: Building2 },
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

        // Cross-company comparative P&L now lives in Finance reporting
        // (/finance/reports/cross-company) — it is a financial report, not a setting.

      ],
    },
  ],
};
