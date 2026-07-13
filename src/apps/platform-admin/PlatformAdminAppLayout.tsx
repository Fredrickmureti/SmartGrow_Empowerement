/**
 * PlatformAdminAppLayout — admin persona counterpart to `PlatformShell`.
 * See `docs/design-system/audit/platform-admin.md` (Phase 7.2).
 *
 * Signature mirrors `PlatformShell(app, nav, children)` — admin is a
 * persona, not an installable app, so there is no `AppRail` and no
 * install/subscription/access gates. Chrome is delegated to the
 * shared `WorkspaceShellFrame` so admin and tenant share identical
 * sidebar/topbar/mobile-Sheet/content-wrapper behavior.
 */
import { useState, type ReactNode } from "react";
import { CountryWorkspaceProvider } from "@/contexts/CountryWorkspaceContext";
import { WorkspaceShellFrame } from "@/components/layout/shell/WorkspaceShellFrame";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { AdminSidebarBody } from "@/components/admin/shell/AdminSidebarBody";
import { AdminTopBar } from "@/components/admin/shell/AdminTopBar";
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <CountryWorkspaceProvider>
      <WorkspaceShellFrame
        sidebar={<AdminSidebar nav={nav} />}
        mobileSidebar={
          <AdminSidebarBody nav={nav} onNavigate={() => setMobileNavOpen(false)} />
        }
        topBar={
          <AdminTopBar nav={nav} onOpenMobileNav={() => setMobileNavOpen(true)} />
        }
        mobileNavOpen={mobileNavOpen}
        onMobileNavOpenChange={setMobileNavOpen}
        mobileSheetWidthClass="w-72"
      >
        {children}
      </WorkspaceShellFrame>
    </CountryWorkspaceProvider>
  );
}

export default PlatformAdminAppLayout;
