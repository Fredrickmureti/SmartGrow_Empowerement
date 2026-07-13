/**
 * PlatformAdminAppLayout — the admin persona's counterpart to
 * `PlatformAppLayout`. See `docs/design-system/audit/platform-admin.md`.
 *
 * Today it delegates to `AdminDashboardLayout` so the sidebar, topbar,
 * and auth/MFA gates stay bit-identical to the rest of the admin
 * console. Newly migrated admin pages import this layout instead of
 * reaching for `AdminDashboardLayout` directly — that indirection is
 * what will let us swap in a fully consolidated shell in a later phase
 * without touching every page.
 */
import type { ReactNode } from "react";
import { AdminDashboardLayout } from "@/components/admin/AdminDashboardLayout";

interface PlatformAdminAppLayoutProps {
  children: ReactNode;
}

export function PlatformAdminAppLayout({ children }: PlatformAdminAppLayoutProps) {
  return <AdminDashboardLayout>{children}</AdminDashboardLayout>;
}

export default PlatformAdminAppLayout;
