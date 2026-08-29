/**
 * AppSwitcher Component
 * 
 * Odoo-style app grid/dropdown for switching between major apps.
 * Shows accessible apps organized by category with visual indicators.
 * Now filters by installed apps and includes marketplace access.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LayoutGrid, Lock, ChevronDown, Home } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import { APP_REGISTRY } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";

interface AppSwitcherProps {
  /** Display variant: "dropdown" for compact, "grid" for full modal */
  variant?: "dropdown" | "grid";
  /** Show only the icon in trigger */
  iconOnly?: boolean;
  /** Custom trigger element */
  trigger?: React.ReactNode;
  /** Additional class names */
  className?: string;
}

export function AppSwitcher({
  variant = "dropdown",
  iconOnly = false,
  trigger,
  className,
}: AppSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();
  const { currentApp, appGroups, canAccessApp, getAppUrl } = useAppNavigation();


  

  const handleAppSelect = (app: AppDefinition) => {
    const url = getAppUrl(app);
    navigate(url);
    setIsOpen(false);
  };

  // Render a single app item
  const AppItem = ({ app, size = "default" }: { app: AppDefinition; size?: "default" | "large" }) => {
    const access = canAccessApp(app);
    const isActive = currentApp?.id === app.id;
    const Icon = app.icon;

    return (
      <button
        onClick={() => access.hasAccess && handleAppSelect(app)}
        disabled={!access.hasAccess}
        className={cn(
          "flex items-center gap-3 rounded-lg p-3 text-left transition-all",
          "hover:bg-accent/50 focus:outline-none focus:ring-2 focus:ring-ring",
          isActive && "bg-accent ring-2 ring-primary/20",
          !access.hasAccess && "opacity-50 cursor-not-allowed",
          size === "large" && "flex-col gap-2 p-4 text-center"
        )}
      >
        <div
          className={cn(
            "flex items-center justify-center rounded-lg",
            size === "default" ? "h-9 w-9" : "h-12 w-12"
          )}
          style={{ backgroundColor: `${app.color}20` }}
        >
          <Icon
            className={cn(size === "default" ? "h-5 w-5" : "h-6 w-6")}
            style={{ color: app.color }}
          />
        </div>
        <div className={cn(size === "large" && "text-center")}>
          <div className="flex items-center gap-1.5">
            <span className={cn(
              "font-medium",
              size === "default" ? "text-sm" : "text-base"
            )}>
              {app.name}
            </span>
            {!access.hasAccess && (
              <Lock className="h-3 w-3 text-muted-foreground" />
            )}
          </div>
          {size === "large" && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {app.description}
            </p>
          )}
        </div>
        {access.denialReason === "subscription" && (
          <Badge variant="secondary" className="ml-auto text-xs">
            Upgrade
          </Badge>
        )}
      </button>
    );
  };

  // Dropdown variant - compact list
  if (variant === "dropdown") {
    return (
      <>
        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
          <DropdownMenuTrigger asChild>
            {trigger || (
              <Button
                variant="ghost"
                size={iconOnly ? "icon" : "default"}
                className={cn("gap-2", className)}
              >
                <LayoutGrid className="h-4 w-4" />
                {!iconOnly && (
                  <>
                    <span className="hidden sm:inline">
                      {currentApp?.name || "Apps"}
                    </span>
                    <ChevronDown className="h-3 w-3 opacity-50" />
                  </>
                )}
              </Button>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={8}
            collisionPadding={12}
            avoidCollisions
            className="w-[min(16rem,calc(100vw-2rem))] max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto overscroll-contain"
          >
            {/* Home link at top */}
            <DropdownMenuItem
              onClick={() => {
                navigate("/home");
                setIsOpen(false);
              }}
              className="flex items-center gap-3 py-2.5 cursor-pointer"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                <Home className="h-4 w-4 text-primary" />
              </div>
              <span className="flex-1 font-medium">Home</span>
            </DropdownMenuItem>
            
            <DropdownMenuSeparator />
            
            {appGroups.map((group, index) => (
              <div key={group.label}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wider">
                  {group.label}
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {group.apps.map((app) => {
                    const access = canAccessApp(app);
                    const isActive = currentApp?.id === app.id;
                    const Icon = app.icon;

                    return (
                      <DropdownMenuItem
                        key={app.id}
                        onClick={() => access.hasAccess && handleAppSelect(app)}
                        disabled={!access.hasAccess}
                        className={cn(
                          "flex items-center gap-3 py-2.5 cursor-pointer",
                          isActive && "bg-accent"
                        )}
                      >
                        <div
                          className="flex h-8 w-8 items-center justify-center rounded-md"
                          style={{ backgroundColor: `${app.color}15` }}
                        >
                          <Icon className="h-4 w-4" style={{ color: app.color }} />
                        </div>
                        <span className="flex-1 font-medium">{app.name}</span>
                        {!access.hasAccess && (
                          <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              </div>
            ))}

          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );
  }

  // Grid variant - full modal with all apps
  return (
    <>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogTrigger asChild>
          {trigger || (
            <Button
              variant="ghost"
              size={iconOnly ? "icon" : "default"}
              className={cn("gap-2", className)}
            >
              <LayoutGrid className="h-4 w-4" />
              {!iconOnly && <span>Apps</span>}
            </Button>
          )}
        </DialogTrigger>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>All Apps</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-4">
            {appGroups.map((group) => (
              <div key={group.label}>
                <h3 className="text-sm font-medium text-muted-foreground mb-3">
                  {group.label}
                </h3>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {group.apps.map((app) => (
                    <AppItem key={app.id} app={app} size="large" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
