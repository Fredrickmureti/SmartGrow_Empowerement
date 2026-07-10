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
import { Lock, LayoutGrid, Home } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AppLayoutProvider, useFullWidthRequested } from "@/contexts/AppLayoutContext";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { AppLandingPage } from "@/components/apps/AppLandingPage";
import { SubscriptionStatusBanner } from "@/components/subscription/SubscriptionStatusBanner";
import { SubscriptionReadOnlyBanner } from "@/components/subscription/SubscriptionReadOnlyBanner";
import { AppTrialBanner } from "@/components/subscription/AppTrialBanner";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useWorkspaceContextReady } from "@/hooks/useWorkspaceContextReady";
import { useRequireActiveBusiness } from "@/hooks/useRequireActiveBusiness";
import { useSession } from "@/contexts/SessionContext";
import type { AppDefinition } from "@/lib/apps/types";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import { AppRail } from "./AppRail";
import { WorkspaceSidebar, SidebarBody } from "./WorkspaceSidebar";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
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
  // Page-level opt-in (via useRequestFullWidth) overrides the shell default.
  const pageFullWidth = useFullWidthRequested();
  const effectiveFullWidth = fullWidth || pageFullWidth;
  return (
    <div className="flex min-h-screen w-full bg-background">
      <AppRail currentApp={app} />
      <WorkspaceSidebar app={app} nav={nav} />

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-80 p-0 flex flex-col">
          <MobileAppSwitcher currentApp={app} onNavigate={() => setMobileNavOpen(false)} />
          <div className="flex-1 min-h-0 overflow-y-auto">
            <SidebarBody app={app} nav={nav} onNavigate={() => setMobileNavOpen(false)} defaultExpandAll />
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex flex-1 flex-col min-w-0">
        <WorkspaceTopBar
          app={app}
          nav={nav}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />
        <SubscriptionStatusBanner />

        <main className="flex-1 overflow-auto">
          <div
            className={cn(
              "mx-auto w-full",
              !effectiveFullWidth && "max-w-6xl",
              !noPadding &&
                (effectiveFullWidth
                  ? "px-4 sm:px-6 lg:px-10 2xl:px-16 py-4"
                  : "px-4 sm:px-6 lg:px-8 py-4"),
            )}
          >
            {!app.internalOnly && <SubscriptionReadOnlyBanner />}
            {!app.internalOnly && !app.isPlatform && (
              <AppTrialBanner appId={app.id} appName={app.name} />
            )}
            {children ?? <Outlet />}
          </div>
        </main>
      </div>
    </div>
  );
}

function MobileAppSwitcher({
  currentApp,
  onNavigate,
}: {
  currentApp: AppDefinition;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const { availableApps, navigateToApp } = useAppNavigation();
  const [expanded, setExpanded] = useState(false);

  const apps = useMemo(
    () =>
      availableApps
        .filter((a) => !a.isPlatform)
        .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99)),
    [availableApps],
  );

  const CurrentIcon = currentApp.icon;

  return (
    <div className="border-b border-border bg-sidebar/50 shrink-0">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-sidebar-accent/50 transition-colors"
        aria-expanded={expanded}
      >
        <span
          className="inline-flex h-8 w-8 items-center justify-center rounded-md shrink-0"
          style={{ backgroundColor: `${currentApp.color}20`, color: currentApp.color }}
        >
          <CurrentIcon className="h-4 w-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Current app
          </div>
          <div className="text-sm font-semibold text-foreground truncate">
            {currentApp.name}
          </div>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {expanded ? "Hide" : "Switch"}
        </span>
      </button>

      {expanded && (
        <div className="max-h-64 overflow-y-auto border-t border-border py-1">
          <button
            type="button"
            onClick={() => {
              navigate("/dashboard");
              onNavigate();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-sidebar-accent/50"
          >
            <Home className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">Home</span>
          </button>
          {apps.map((a) => {
            const Icon = a.icon;
            const active = a.id === currentApp.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  if (!active) navigateToApp(a.id);
                  onNavigate();
                }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-sidebar-accent/50 transition-colors",
                  active ? "bg-sidebar-accent text-foreground font-medium" : "text-foreground",
                )}
              >
                <Icon
                  className="h-4 w-4 shrink-0"
                  style={{ color: active ? a.color : undefined }}
                />
                <span className="truncate flex-1 text-left">{a.name}</span>
                {active && (
                  <span
                    className="h-1.5 w-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: a.color }}
                  />
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => {
              navigate("/apps");
              onNavigate();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-sidebar-accent/50 border-t border-border mt-1"
          >
            <LayoutGrid className="h-4 w-4 shrink-0" />
            <span className="truncate">All apps</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default PlatformShell;

