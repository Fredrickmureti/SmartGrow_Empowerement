/**
 * Platform (Settings / Workspace) App Layout.
 *
 * Wraps every cross-app configuration surface (Settings, Team, Apps,
 * Notifications, Compliance, Audit Logs, Billing, Upgrade, Consolidation,
 * etc.) in the unified PlatformShell — replacing the legacy DashboardLayout
 * wrapper so platform-level pages inherit the same rail + sidebar + topbar
 * chrome as every workspace app.
 */
import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { PLATFORM_APP } from "@/lib/apps/registry";
import { PLATFORM_NAV } from "./nav";

interface PlatformAppLayoutProps {
  children: ReactNode;
}

export function PlatformAppLayout({ children }: PlatformAppLayoutProps) {
  return (
    <PlatformShell app={PLATFORM_APP} nav={PLATFORM_NAV}>
      {children}
    </PlatformShell>
  );
}

export default PlatformAppLayout;
