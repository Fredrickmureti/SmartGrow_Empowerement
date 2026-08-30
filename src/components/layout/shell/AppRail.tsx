/**
 * AppRail — left rail listing installed apps.
 *
 * Collapsible: narrow icon-only mode (w-14) or expanded mode (w-52) that
 * shows app names next to their icons. Toggle sits at the top of the rail.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LayoutGrid,
  Home,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import type { AppDefinition } from "@/lib/apps/types";

interface AppRailProps {
  currentApp: AppDefinition;
}

const STORAGE_KEY = "lov:app-rail:collapsed";

export function AppRail({ currentApp }: AppRailProps) {
  const navigate = useNavigate();
  const { availableApps, navigateToApp } = useAppNavigation();

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === "1";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    }
  }, [collapsed]);

  const apps = useMemo(
    () =>
      availableApps
        .filter((a) => !a.alwaysAvailable)
        .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99)),
    [availableApps],
  );

  const maybeTooltip = (label: string, node: React.ReactElement) =>
    collapsed ? (
      <Tooltip>
        <TooltipTrigger asChild>{node}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    ) : (
      node
    );

  return (
    <TooltipProvider delayDuration={150}>
      <aside
        aria-label="Apps"
        className={cn(
          "hidden md:flex h-screen sticky top-0 shrink-0 flex-col border-r border-border bg-sidebar z-40 transition-[width] duration-200",
          collapsed ? "w-14 items-center" : "w-52",
        )}
      >
        {/* Header: toggle */}
        <div
          className={cn(
            "flex h-12 items-center border-b border-border w-full shrink-0",
            collapsed ? "justify-center px-0" : "justify-between px-2",
          )}
        >
          {!collapsed && (
            <span className="text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/60 pl-1">
              Apps
            </span>
          )}
          {maybeTooltip(
            collapsed ? "Expand app rail" : "Collapse app rail",
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? "Expand app rail" : "Collapse app rail"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </button>,
          )}
        </div>

        <div className={cn("w-full pt-2", collapsed ? "px-0 flex justify-center" : "px-2")}>
          {maybeTooltip(
            "Home",
            <button
              type="button"
              onClick={() => navigate("/dashboard")}
              className={cn(
                "mb-1 inline-flex items-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors",
                collapsed ? "h-9 w-9 justify-center" : "h-9 w-full gap-2 px-2",
              )}
              aria-label="Home"
            >
              <Home className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="text-sm truncate">Home</span>}
            </button>,
          )}
        </div>

        <div className={cn("my-1 h-px bg-border", collapsed ? "w-6" : "w-full")} aria-hidden />

        <nav
          className={cn(
            "flex flex-col gap-0.5 overflow-y-auto scrollbar-hide flex-1 min-h-0 w-full",
            collapsed ? "items-center px-1" : "px-2",
          )}
        >
          {apps.map((app) => {
            const Icon = app.icon;
            const active = app.id === currentApp.id;
            const button = (
              <button
                type="button"
                onClick={() => navigateToApp(app.id)}
                aria-label={app.name}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative inline-flex items-center rounded-md transition-colors",
                  collapsed ? "h-10 w-10 justify-center" : "h-10 w-full gap-2 px-2",
                  active
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r"
                    style={{ backgroundColor: app.color }}
                  />
                )}
                <Icon className="h-[18px] w-[18px] shrink-0" />
                {!collapsed && <span className="text-sm truncate">{app.name}</span>}
              </button>
            );
            return (
              <div key={app.id} className="w-full flex justify-center">
                {maybeTooltip(app.name, button)}
              </div>
            );
          })}
        </nav>

        <div className={cn("w-full pb-2", collapsed ? "px-0 flex justify-center" : "px-2")}>
          {maybeTooltip(
            "All apps",
            <button
              type="button"
              onClick={() => navigate("/apps")}
              className={cn(
                "mt-1 inline-flex items-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors",
                collapsed ? "h-9 w-9 justify-center" : "h-9 w-full gap-2 px-2",
              )}
              aria-label="All apps"
            >
              <LayoutGrid className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="text-sm truncate">All apps</span>}
            </button>,
          )}
        </div>
      </aside>
    </TooltipProvider>
  );
}
