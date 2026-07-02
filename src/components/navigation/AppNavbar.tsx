/**
 * AppNavbar Component
 * 
 * Top navigation bar with app switcher and quick access to main apps.
 * Provides Odoo-style navigation with dropdown menus for each app.
 */

import { Link, useNavigate } from "react-router-dom";
import { LayoutDashboard, ChevronDown, Bell, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AppSwitcher } from "./AppSwitcher";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import { useCommandPaletteContext } from "@/providers/CommandPaletteProvider";
import type { AppDefinition } from "@/lib/apps/types";

interface AppNavbarProps {
  /** Whether to show the dashboard link */
  showDashboard?: boolean;
  /** Maximum number of apps to show in the navbar (rest in "More" dropdown) */
  maxVisibleApps?: number;
  /** Additional class names */
  className?: string;
}

export function AppNavbar({
  showDashboard = true,
  maxVisibleApps = 6,
  className,
}: AppNavbarProps) {
  const navigate = useNavigate();
  const { setOpen: setPaletteOpen } = useCommandPaletteContext();
  const { 
    currentApp, 
    availableApps, 
    canAccessApp, 
    getAccessibleModules,
    isAppActive,
    getAppUrl,
  } = useAppNavigation();

  // Split apps into visible and overflow
  const visibleApps = availableApps.slice(0, maxVisibleApps);
  const overflowApps = availableApps.slice(maxVisibleApps);

  // Render a single app nav item with dropdown
  const AppNavItem = ({ app }: { app: AppDefinition }) => {
    const isActive = isAppActive(app.id);
    const modules = getAccessibleModules(app);
    const Icon = app.icon;

    // If only one module, link directly to it
    if (modules.length <= 1) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={getAppUrl(app)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="hidden lg:inline">{app.name}</span>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="lg:hidden">
            {app.name}
          </TooltipContent>
        </Tooltip>
      );
    }

    // Multiple modules - show dropdown
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "gap-1.5 px-3",
                  isActive
                    ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="hidden lg:inline">{app.name}</span>
                <ChevronDown className="h-3 w-3 opacity-50 hidden lg:block" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="lg:hidden">
            {app.name}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-48">
          {modules.filter(m => !m.hidden).map((module) => {
            const ModuleIcon = module.icon;
            return (
              <DropdownMenuItem
                key={module.id}
                onClick={() => navigate(`${app.basePath}${module.path}`)}
                className="flex items-center gap-2 py-2 cursor-pointer"
              >
                <ModuleIcon className="h-4 w-4" style={{ color: app.color }} />
                <span>{module.name}</span>
                {module.badge && (
                  <span className="ml-auto text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                    {module.badge}
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <nav
      className={cn(
        "flex items-center gap-1 px-2 py-1.5 border-b bg-card overflow-x-auto",
        className
      )}
    >
      {/* App Switcher (Grid icon) */}
      <AppSwitcher variant="dropdown" iconOnly className="shrink-0" />

      {/* Dashboard link */}
      {showDashboard && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/dashboard"
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors shrink-0",
                "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <LayoutDashboard className="h-4 w-4" />
              <span className="hidden lg:inline">Dashboard</span>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="lg:hidden">
            Dashboard
          </TooltipContent>
        </Tooltip>
      )}

      {/* Separator */}
      <div className="h-6 w-px bg-border mx-1 shrink-0" />

      {/* Visible apps */}
      <div className="flex items-center gap-0.5">
        {visibleApps.map((app) => (
          <AppNavItem key={app.id} app={app} />
        ))}
      </div>

      {/* Overflow apps */}
      {overflowApps.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground">
              <span>More</span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {overflowApps.map((app) => {
              const Icon = app.icon;
              return (
                <DropdownMenuItem
                  key={app.id}
                  onClick={() => navigate(getAppUrl(app))}
                  className="flex items-center gap-2 py-2 cursor-pointer"
                >
                  <Icon className="h-4 w-4" style={{ color: app.color }} />
                  <span>{app.name}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right side actions */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Global command palette trigger */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="hidden md:inline-flex items-center gap-2 text-muted-foreground"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <Search className="h-4 w-4" />
              <span className="hidden lg:inline text-xs">Search…</span>
              <kbd className="hidden lg:inline rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none">
                ⌘K
              </kbd>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Search (⌘K)</TooltipContent>
        </Tooltip>

        {/* Notifications */}
        <Button variant="ghost" size="icon">
          <Bell className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  );
}
