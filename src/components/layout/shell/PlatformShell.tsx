/**
 * PlatformShell — the new platform-wide workspace shell.
 *
 * Three regions:
 *   ┌────┬──────────┬──────────────────────────────┐
 *   │Rail│ Sidebar  │ TopBar                       │
 *   │ 56 │   240    │ ──────────────────────────── │
 *   │    │          │ Page content (max-w-6xl)     │
 *   └────┴──────────┴──────────────────────────────┘
 *
 * Replaces AppWorkspaceLayout's horizontal-tab model. Same install /
 * access / loading gates apply, so unmigrated apps can keep using
 * AppWorkspaceLayout side-by-side during the rollout.
 */
import { ReactNode, useMemo, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AppLayoutProvider } from "@/contexts/AppLayoutContext";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { AppLandingPage } from "@/components/apps/AppLandingPage";
import { SubscriptionReadOnlyBanner } from "@/components/subscription/SubscriptionReadOnlyBanner";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useWorkspaceContextReady } from "@/hooks/useWorkspaceContextReady";
import { useRequireActiveBusiness } from "@/hooks/useRequireActiveBusiness";
import { useSession } from "@/contexts/SessionContext";
import type { AppDefinition } from "@/lib/apps/types";

import { AppRail } from "./AppRail";
import { WorkspaceSidebar, SidebarBody } from "./WorkspaceSidebar";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
import { WorkspaceShellFrame } from "./WorkspaceShellFrame";
import type { WorkspaceNav } from "./types";

interface PlatformShellProps {
  app: AppDefinition;
  nav: WorkspaceNav;
  children?: ReactNode;
  /** Drop the max-w-6xl page-content cap (for sub-apps that own internal layouts). */
  fullWidth?: boolean;
  /** Drop the default content padding. */
  noPadding?: boolean;
}

export function PlatformShell({
  app,
  nav,
  children,
  fullWidth = false,
  noPadding = false,
}: PlatformShellProps) {
  const navigate = useNavigate();
  const { userType } = useSession();
  const { canAccessApp } = useAppNavigation();
  const { isInstalled, installApp } = useInstalledApps();
  const { ready: workspaceReady } = useWorkspaceContextReady({ appId: app.id });
  const [isActivating, setIsActivating] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Honor the active-business contract, but only after the workspace snapshot
  // is authoritative. During sign-in, /home can mount before BusinessContext
  // has switched from its signed-out snapshot to the selected org; firing here
  // creates the false "Select a Company to use Home" toast.
  useRequireActiveBusiness(app.name, { enabled: workspaceReady });

  const accessInfo = useMemo(() => canAccessApp(app), [app, canAccessApp]);
  const isAppInstalled = app.isPlatform || isInstalled(app.id);

  // Portal users get the DashboardLayout-driven shell, never this one.
  if (userType === "portal") return <>{children ?? <Outlet />}</>;

  if (!workspaceReady) {
    return <BrandedLoader message="Loading workspace..." />;
  }

  if (!isAppInstalled) {
    const handleActivate = async () => {
      setIsActivating(true);
      try {
        await installApp(app.id);
      } finally {
        setIsActivating(false);
      }
    };
    return (
      <AppLandingPage app={app} onActivate={handleActivate} isActivating={isActivating} />
    );
  }

  if (!accessInfo.hasAccess) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-8 text-center">
        <div className="rounded-full bg-destructive/10 p-4 mb-4">
          <Lock className="h-8 w-8 text-destructive" />
        </div>
        <h2 className="text-xl font-semibold mb-2">Access Restricted</h2>
        <p className="text-muted-foreground max-w-md mb-6">
          {accessInfo.denialReason === "subscription"
            ? "This feature requires a higher subscription plan. Upgrade to unlock access."
            : "You don't have permission to access this section. Contact your administrator."}
        </p>
        {accessInfo.denialReason === "subscription" && (
          <Button onClick={() => navigate("/settings/subscription")}>View Plans</Button>
        )}
      </div>
    );
  }

  return (
    <AppLayoutProvider appId={app.id}>
      <PlatformShellBody
        app={app}
        nav={nav}
        fullWidth={fullWidth}
        noPadding={noPadding}
        mobileNavOpen={mobileNavOpen}
        setMobileNavOpen={setMobileNavOpen}
      >
        {children}
      </PlatformShellBody>
    </AppLayoutProvider>
  );
}

interface PlatformShellBodyProps {
  app: AppDefinition;
  nav: WorkspaceNav;
  fullWidth: boolean;
  noPadding: boolean;
  mobileNavOpen: boolean;
  setMobileNavOpen: (v: boolean) => void;
  children?: ReactNode;
}

function PlatformShellBody({
  app,
  nav,
  fullWidth,
  noPadding,
  mobileNavOpen,
  setMobileNavOpen,
  children,
}: PlatformShellBodyProps) {
  return (
    <WorkspaceShellFrame
      sidebar={
        <>
          <AppRail currentApp={app} />
          <WorkspaceSidebar app={app} nav={nav} />
        </>
      }
      mobileSidebar={
        <div className="flex-1 min-h-0 overflow-y-auto">
          <SidebarBody
            app={app}
            nav={nav}
            onNavigate={() => setMobileNavOpen(false)}
            defaultExpandAll
            showAppSwitcher
          />
        </div>
      }
      topBar={
        <WorkspaceTopBar
          app={app}
          nav={nav}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />
      }
      insideContent={
        <>
          {!app.internalOnly && <SubscriptionReadOnlyBanner />}
        </>
      }
      fullWidth={fullWidth}
      noPadding={noPadding}
      mobileNavOpen={mobileNavOpen}
      onMobileNavOpenChange={setMobileNavOpen}
    >
      {children ?? <Outlet />}
    </WorkspaceShellFrame>
  );
}


export default PlatformShell;

