/**
 * PlatformAdminAppLayout — the admin persona's counterpart to
 * `PlatformShell`. See `docs/design-system/audit/platform-admin.md`
 * and `docs/design-system.md`.
 *
 * Signature mirrors `PlatformShell(app, nav, children)` — admin is a
 * persona rather than an installable app, so there is no `AppRail`
 * or install/subscription gating, but the `nav` contract is the
 * same shape as tenant apps supply (`WorkspaceNav`). This is the
 * Phase-7 structural handle: swapping the visual shell later is a
 * matter of changing what this component renders, without touching
 * page-level code or the nav data source.
 */
import type { ReactNode } from "react";
import { AdminDashboardLayout } from "@/components/admin/AdminDashboardLayout";
import { PLATFORM_ADMIN_NAV, type AdminWorkspaceNav } from "./nav";

interface PlatformAdminAppLayoutProps {
  children: ReactNode;
  /** Workspace navigation config. Defaults to `PLATFORM_ADMIN_NAV`. */
  nav?: AdminWorkspaceNav;
}

export function PlatformAdminAppLayout({
  children,
  nav = PLATFORM_ADMIN_NAV,
}: PlatformAdminAppLayoutProps) {
  return <AdminDashboardLayout nav={nav}>{children}</AdminDashboardLayout>;
}

export default PlatformAdminAppLayout;
