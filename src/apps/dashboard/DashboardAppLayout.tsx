/**
 * Dashboard App Layout — PlatformShell (rail + sidebar + topbar).
 *
 * Replaces the legacy DashboardLayout (`AppAwareSidebar` + custom topbar)
 * with the unified workspace shell so the global Dashboard inherits the
 * exact same chrome as Finance, Sales, HR, etc. — one design foundation.
 */
import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { DASHBOARD_APP } from "@/lib/apps/registry";
import { DASHBOARD_NAV } from "./nav";

interface DashboardAppLayoutProps {
  children: ReactNode;
}

export function DashboardAppLayout({ children }: DashboardAppLayoutProps) {
  return (
    <PlatformShell app={DASHBOARD_APP} nav={DASHBOARD_NAV}>
      {children}
    </PlatformShell>
  );
}

export default DashboardAppLayout;
