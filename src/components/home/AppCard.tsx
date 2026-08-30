/**
 * AppCard Component
 * 
 * Individual app card for the app launcher grid.
 * Shows app icon, name, description, and install status.
 */

import { Lock, Check, Download, Trash2, Clock, Sparkles, Tag, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import type { AppDefinition } from "@/lib/apps/types";
import type { AppLifecycleAction } from "@/lib/apps/lifecycle";

interface AppCardProps {
  app: AppDefinition;
  isInstalled: boolean;
  isLocked: boolean;
  lockReason?: "subscription" | "permission" | "disabled";
  isActive?: boolean;
  size?: "default" | "large" | "compact";
  showActions?: boolean;
  onSelect?: () => void;
  /** @deprecated use lifecycleAction instead */
  onInstall?: () => void;
  onUninstall?: () => void;
  canUninstall?: boolean;
  className?: string;
  /**
   * State-aware lifecycle action (preferred over onInstall). When provided,
   * the install icon-button is replaced by a labeled primary button that
   * matches the entitlement state (Install / Start trial / Subscribe / Open).
   */
  lifecycleAction?: AppLifecycleAction;
  /** Setup-readiness summary shown as an amber sub-row when installed but not configured. */
  setupRequired?: { isReady: boolean; reasons?: string[] } | null;
}

export function AppCard({
  app,
  isInstalled,
  isLocked,
  lockReason,
  isActive = false,
  size = "default",
  showActions = false,
  onSelect,
  onInstall,
  onUninstall,
  canUninstall = true,
  className,
  lifecycleAction,
  setupRequired,
}: AppCardProps) {
  const Icon = app.icon;
  const isMobile = useIsMobile();

  // Odoo-style: an unshipped app is shown as a disabled "Coming soon" tile,
  // never blurred or treated as a paywalled lock. Plan-based locking is
  // resolved at install-time, not as a visual gate on the marketplace.
  const isComingSoon = !!app.comingSoon;
  const visuallyDisabled = isComingSoon || (isLocked && lockReason === "permission");
  const setupBlocked = isInstalled && setupRequired && setupRequired.isReady === false;
  
  // On mobile, force compact-like sizing for large cards
  const effectiveSize = isMobile && size === "large" ? "mobile" : size;

  const handleClick = () => {
    if (visuallyDisabled) return;
    if (isInstalled && onSelect) {
      onSelect();
    }
  };

  const sizeClasses = {
    compact: "p-2 gap-2",
    default: "p-3 gap-3",
    mobile: "p-2.5 gap-2 flex-col text-center",
    large: "p-4 gap-3 flex-col text-center",
  };

  const iconSizeClasses = {
    compact: "h-8 w-8",
    default: "h-10 w-10",
    mobile: "h-10 w-10",
    large: "h-14 w-14",
  };

  const iconInnerClasses = {
    compact: "h-4 w-4",
    default: "h-5 w-5",
    mobile: "h-5 w-5",
    large: "h-7 w-7",
  };

  return (
    <div
      onClick={handleClick}
      className={cn(
        "relative flex items-center rounded-xl border bg-card transition-all duration-200",
        sizeClasses[effectiveSize],
        isInstalled && !visuallyDisabled && "cursor-pointer hover:bg-accent/50 hover:shadow-md hover:border-primary/20",
        isActive && "ring-2 ring-primary shadow-lg",
        visuallyDisabled && "opacity-60 cursor-not-allowed",
        className
      )}
    >
      {/* App Icon */}
      <div
        className={cn(
          "flex items-center justify-center rounded-xl shrink-0",
          iconSizeClasses[effectiveSize]
        )}
        style={{ 
          backgroundColor: `${app.color}15`,
          color: app.color,
        }}
      >
        <Icon className={cn(iconInnerClasses[effectiveSize])} />
      </div>

      {/* App Info */}
      <div className={cn("flex-1 min-w-0", (effectiveSize === "large" || effectiveSize === "mobile") && "text-center")}>
        <div className="flex items-center gap-1 justify-center flex-wrap">
          <h3 className={cn(
            "font-semibold truncate",
            effectiveSize === "compact" ? "text-sm" : effectiveSize === "mobile" ? "text-xs" : effectiveSize === "large" ? "text-base" : "text-sm"
          )}>
            {app.name}
          </h3>
          {isComingSoon && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              </TooltipTrigger>
              <TooltipContent>Coming soon — not available to install yet</TooltipContent>
            </Tooltip>
          )}
          {isLocked && lockReason === "permission" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              </TooltipTrigger>
              <TooltipContent>
                You don't have permission to access this app
              </TooltipContent>
            </Tooltip>
          )}
          {isInstalled && !visuallyDisabled && (
            <Check className="h-3.5 w-3.5 text-primary shrink-0" />
          )}
        </div>
        
        {/* Hide description on mobile */}
        {effectiveSize !== "compact" && effectiveSize !== "mobile" && (
          <p className={cn(
            "text-muted-foreground mt-0.5 line-clamp-2",
            effectiveSize === "large" ? "text-sm" : "text-xs"
          )}>
            {app.description}
          </p>
        )}

        {/* 5-state entitlement badge row (suppressed once installed) */}
        {!isInstalled && !isComingSoon && entitlementState && entitlementState !== "coming_soon" && (
          <div className={cn(
            "mt-1.5 flex items-center gap-1 flex-wrap",
            (effectiveSize === "large" || effectiveSize === "mobile") && "justify-center"
          )}>
            {entitlementState === "in_plan" && (
              <Badge variant="secondary" className="text-[10px] gap-1">
                <Check className="h-3 w-3" /> Included in plan
              </Badge>
            )}
            {entitlementState === "trial" && (
              <Badge className="text-[10px] gap-1 bg-primary/15 text-primary hover:bg-primary/20 border-transparent">
                <Sparkles className="h-3 w-3" />
                {trialDaysLeft != null ? `Trial · ${trialDaysLeft}d left` : "On trial"}
              </Badge>
            )}
            {entitlementState === "addon" && (
              <Badge variant="outline" className="text-[10px] gap-1">
                <Tag className="h-3 w-3" />
                {addonPriceLabel ?? "Add-on"}
              </Badge>
            )}
            {entitlementState === "expired_trial" && (
              <Badge variant="outline" className="text-[10px] gap-1 border-destructive/40 text-destructive">
                <Clock className="h-3 w-3" /> Trial ended
              </Badge>
            )}
            {entitlementState === "overridden" && (
              <Badge variant="secondary" className="text-[10px] gap-1">
                <Check className="h-3 w-3" /> Granted
              </Badge>
            )}
          </div>
        )}

        {/* Setup-required sub-row (installed but configuration incomplete). */}
        {setupBlocked && (
          <div className={cn(
            "mt-1.5 flex items-center gap-1 flex-wrap",
            (effectiveSize === "large" || effectiveSize === "mobile") && "justify-center"
          )}>
            <Badge variant="outline" className="text-[10px] gap-1 border-amber-500/40 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" />
              Setup required
              {setupRequired?.reasons?.length ? `: ${setupRequired.reasons.slice(0, 2).join(", ")}` : ""}
            </Badge>
          </div>
        )}
      </div>

      {/* Actions */}
      {showActions && (
        <div className="flex items-center gap-1 shrink-0">
          {isComingSoon && (
            <Badge variant="outline" className="text-xs">Coming soon</Badge>
          )}

          {/* Preferred path: state-aware lifecycle button */}
          {!isComingSoon && lifecycleAction && lifecycleAction.intent !== "open" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant={lifecycleAction.intent === "subscribe" ? "default" : "outline"}
                  disabled={lifecycleAction.disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    void lifecycleAction.onClick();
                  }}
                  className="h-8"
                >
                  {lifecycleAction.label}
                </Button>
              </TooltipTrigger>
              {lifecycleAction.hint && (
                <TooltipContent>{lifecycleAction.hint}</TooltipContent>
              )}
            </Tooltip>
          )}

          {/* Secondary action (e.g. Subscribe next to Start trial) */}
          {!isComingSoon && lifecycleAction?.secondary && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                void lifecycleAction.secondary!.onClick();
              }}
              className="h-8"
            >
              {lifecycleAction.secondary.label}
            </Button>
          )}

          {/* Legacy path — kept for callers that haven't migrated yet */}
          {!lifecycleAction && !isInstalled && !visuallyDisabled && onInstall && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={(e) => {
                    e.stopPropagation();
                    onInstall();
                  }}
                >
                  <Download className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Install {app.name}</TooltipContent>
            </Tooltip>
          )}

          {isInstalled && canUninstall && onUninstall && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUninstall();
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Uninstall {app.name}</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
