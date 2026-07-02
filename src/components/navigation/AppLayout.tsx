/**
 * AppLayout Component
 * 
 * Wrapper layout for app pages that provides:
 * - App-specific sidebar with module navigation
 * - Consistent header with breadcrumbs
 * - Access control and error boundaries
 */

import { ReactNode, useMemo } from "react";
import { Link, useNavigate, Outlet } from "react-router-dom";
import { ChevronRight, Lock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import { useDeprecationWarning } from "@/design-system/internal/useDeprecationWarning";
import type { AppDefinition, ModuleDefinition } from "@/lib/apps/types";

interface AppLayoutProps {
  /** The app definition (passed by route) */
  app: AppDefinition;
  /** Override the default modules to show */
  modules?: ModuleDefinition[];
  /** Whether to show the app sidebar */
  showSidebar?: boolean;
  /** Whether the sidebar is collapsed by default */
  defaultCollapsed?: boolean;
  /** Custom header content */
  headerContent?: ReactNode;
  /** Children to render (if not using Outlet) */
  children?: ReactNode;
  /** Additional class names for the main content area */
  contentClassName?: string;
}

/**
 * @deprecated Use `WorkspaceShell` from `@/design-system` instead.
 * Kept only so unmigrated modules keep rendering. See docs/design-system.md.
 */
export function AppLayout({
  app,
  modules: overrideModules,
  showSidebar = true,
  defaultCollapsed = false,
  headerContent,
  children,
  contentClassName,
}: AppLayoutProps) {
  useDeprecationWarning("AppLayout", "<WorkspaceShell>");
  const navigate = useNavigate();
  const {
    currentModule,
    canAccessApp,
    getAccessibleModules,
    isModuleActive,
  } = useAppNavigation();

  // Get access info for this app
  const accessInfo = useMemo(() => canAccessApp(app), [app, canAccessApp]);

  // Get modules to display
  const displayModules = useMemo(() => {
    if (overrideModules) return overrideModules;
    return getAccessibleModules(app).filter(m => !m.hidden);
  }, [app, overrideModules, getAccessibleModules]);

  // If no access, show access denied view
  if (!accessInfo.hasAccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center">
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
          <Button onClick={() => navigate("/settings/subscription")}>
            View Plans
          </Button>
        )}
      </div>
    );
  }

  // Render sidebar module item
  const ModuleItem = ({ module }: { module: ModuleDefinition }) => {
    const isActive = isModuleActive(app, module.id);
    const Icon = module.icon;
    const fullPath = `${app.basePath}${module.path}`;

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={fullPath}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{module.name}</span>
            {module.badge && (
              <Badge
                variant={isActive ? "secondary" : "outline"}
                className="ml-auto text-xs"
              >
                {module.badge}
              </Badge>
            )}
          </Link>
        </TooltipTrigger>
        {module.description && (
          <TooltipContent side="right" className="max-w-xs">
            {module.description}
          </TooltipContent>
        )}
      </Tooltip>
    );
  };

  return (
    <div className="flex min-h-screen">
      {/* App Sidebar */}
      {showSidebar && (
        <aside className="w-56 border-r bg-card shrink-0 hidden md:block">
          {/* App Header */}
          <div className="p-4 border-b">
            <div className="flex items-center gap-2">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-lg"
                style={{ backgroundColor: `${app.color}15` }}
              >
                <app.icon className="h-4 w-4" style={{ color: app.color }} />
              </div>
              <div>
                <h2 className="font-semibold text-sm">{app.name}</h2>
                {accessInfo.isReadOnly && (
                  <span className="text-xs text-muted-foreground">Read-only</span>
                )}
              </div>
            </div>
          </div>

          {/* Module Navigation */}
          <ScrollArea className="flex-1 h-[calc(100vh-8rem)]">
            <nav className="p-2 space-y-1">
              {displayModules.map((module) => (
                <ModuleItem key={module.id} module={module} />
              ))}
            </nav>
          </ScrollArea>
        </aside>
      )}

      {/* Main Content */}
      <main className={cn("flex-1 flex flex-col min-w-0", contentClassName)}>
        {/* Breadcrumb Header */}
        <header className="flex items-center gap-2 px-4 sm:px-6 py-3 border-b bg-card/50">
          <nav className="flex items-center gap-1 text-sm">
            <Link
              to={`${app.basePath}${app.modules[0]?.path || ""}`}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {app.name}
            </Link>
            {currentModule && (
              <>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{currentModule.name}</span>
              </>
            )}
          </nav>
          
          {/* Custom header content */}
          {headerContent && (
            <div className="ml-auto flex items-center gap-2">
              {headerContent}
            </div>
          )}
        </header>

        {/* Page Content */}
        <div className="flex-1 p-4 sm:p-6 overflow-auto">
          {children || <Outlet />}
        </div>
      </main>
    </div>
  );
}

/**
 * Mobile app navigation - shown in drawer on small screens
 */
export function MobileAppNav({ app }: { app: AppDefinition }) {
  const { getAccessibleModules, isModuleActive } = useAppNavigation();
  const modules = getAccessibleModules(app).filter(m => !m.hidden);

  return (
    <div className="space-y-1 p-2">
      {modules.map((module) => {
        const isActive = isModuleActive(app, module.id);
        const Icon = module.icon;

        return (
          <Link
            key={module.id}
            to={`${app.basePath}${module.path}`}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent"
            )}
          >
            <Icon className="h-4 w-4" />
            <span>{module.name}</span>
          </Link>
        );
      })}
    </div>
  );
}
