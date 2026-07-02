/**
 * AppRail — slim left rail (56px) that lists installed apps as icons.
 *
 * Replaces the legacy "app switcher modal + dropdown" model with a
 * always-visible rail. Icons only; tooltip on hover; active app shows
 * a 2px accent bar in the app's brand color.
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { LayoutGrid, Home } from "lucide-react";
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
  /** The app currently rendered (for active-state). */
  currentApp: AppDefinition;
}

export function AppRail({ currentApp }: AppRailProps) {
  const navigate = useNavigate();
  const { availableApps, navigateToApp } = useAppNavigation();

  const apps = useMemo(
    () =>
      availableApps
        .filter((a) => !a.isPlatform)
        .sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99)),
    [availableApps],
  );

  return (
    <TooltipProvider delayDuration={150}>
      <aside
        aria-label="Apps"
        className="hidden md:flex h-screen sticky top-0 w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-2 z-40"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => navigate("/dashboard")}
              className="mb-1 inline-flex h-9 w-9 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
              aria-label="Home"
            >
              <Home className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Home</TooltipContent>
        </Tooltip>

        <div className="my-1 h-px w-6 bg-border" aria-hidden />

        <nav className="flex flex-col items-center gap-0.5 overflow-y-auto scrollbar-hide flex-1 min-h-0 w-full px-1">
          {apps.map((app) => {
            const Icon = app.icon;
            const active = app.id === currentApp.id;
            return (
              <Tooltip key={app.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => navigateToApp(app.id)}
                    aria-label={app.name}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative inline-flex h-10 w-10 items-center justify-center rounded-md transition-colors",
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
                    <Icon className="h-[18px] w-[18px]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{app.name}</TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => navigate("/apps")}
              className="mt-1 inline-flex h-9 w-9 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
              aria-label="All apps"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">All apps</TooltipContent>
        </Tooltip>
      </aside>
    </TooltipProvider>
  );
}
