/**
 * Dashboard workspace nav.
 *
 * Two surfaces ship today:
 *  - `/`          → launcher (QuickActions + QuickStats + AppLauncher)
 *  - `/dashboard` → command-center overview
 *
 * Both render through `DashboardAppLayout` (PlatformShell), so they are
 * peer entries in the workspace sidebar. Future surfaces (Activity,
 * Approvals, Insights, Trends) are intentionally omitted until their
 * pages exist — listing dead links was a recurring source of 404s.
 */
import { Home as HomeIcon, LayoutDashboard } from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const DASHBOARD_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Overview",
      items: [
        { to: "/", label: "Launcher", icon: HomeIcon, end: true },
        { to: "/dashboard", label: "Command center", icon: LayoutDashboard, end: true },
      ],
    },
  ],
};
