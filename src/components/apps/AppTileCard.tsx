/**
 * AppTileCard - Odoo-style Marketplace Tile
 * 
 * Vertical card with:
 * - Large centered icon with app color background
 * - App name centered below
 * - Short tagline/description
 * - Install/Open button at bottom
 */

import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Lock, Check, Download, ArrowRight, Clock, Sparkles, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useIsMobile } from "@/hooks/use-mobile";
import type { AppDefinition } from "@/lib/apps/types";

interface AppTileCardProps {
  app: AppDefinition;
  isInstalled: boolean;
  isLocked?: boolean;
  lockedLabel?: string;
  onInstall?: () => void;
  onOpen?: () => void;
  size?: "small" | "medium" | "large";
  showDescription?: boolean;
  /**
   * State-aware lifecycle action (preferred). When provided, replaces the
   * generic Install/Open button so the gesture matches the marketplace
   * (Install / Start trial / Subscribe / Open / Coming soon). Pass the result
   * of useAppLifecycle().getAction(app) here.
   */
  lifecycleAction?: import("@/lib/apps/lifecycle").AppLifecycleAction;
}

export function AppTileCard({
  app,
  isInstalled,
  isLocked = false,
  lockedLabel,
  onInstall,
  onOpen,
  size = "medium",
  showDescription = true,
  lifecycleAction,
}: AppTileCardProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const AppIcon = app.icon;
  const isComingSoon = Boolean(app.comingSoon);
  // Only "coming soon" or RBAC-locked tiles are visually muted. Paywall/addon
  // tiles stay clickable — clicking opens the landing page where the user can
  // start a trial or subscribe (Odoo pattern: never blur away the marketplace).
  const visuallyDisabled = isComingSoon || isLocked;

  // On mobile, use compact size regardless of prop
  const effectiveSize = isMobile ? "compact" : size;
  const shouldShowDescription = isMobile ? false : showDescription;

  const sizeClasses = {
    compact: {
      card: "p-2.5",
      iconContainer: "h-10 w-10",
      icon: "h-5 w-5",
      name: "text-xs",
      description: "text-[10px]",
      button: "h-7 text-[10px] px-2",
    },
    small: {
      card: "p-3",
      iconContainer: "h-10 w-10",
      icon: "h-5 w-5",
      name: "text-xs",
      description: "text-[10px]",
      button: "h-8 text-xs",
    },
    medium: {
      card: "p-4",
      iconContainer: "h-14 w-14",
      icon: "h-7 w-7",
      name: "text-sm",
      description: "text-xs",
      button: "h-9 text-sm",
    },
    large: {
      card: "p-6",
      iconContainer: "h-20 w-20",
      icon: "h-10 w-10",
      name: "text-base",
      description: "text-sm",
      button: "h-10 text-base",
    },
  };

  const sizes = sizeClasses[effectiveSize];

  const handleClick = () => {
    // Coming-soon tiles route to the under-development landing page so the
    // user gets a real explanation + notify-me CTA instead of a dead blur.
    if (isComingSoon) {
      navigate(`/apps/${app.id}/activate`);
      return;
    }
    // RBAC-locked tile: route to landing where Request-Access dialog is offered.
    if (isLocked) {
      navigate(`/apps/${app.id}/activate`);
      return;
    }
    if (isInstalled) {
      const defaultModule = app.defaultModule
        ? app.modules.find(m => m.id === app.defaultModule)
        : app.modules[0];
      const defaultPath = `${app.basePath}${defaultModule?.path || ""}`;
      navigate(defaultPath);
      onOpen?.();
    } else {
      onInstall?.();
    }
  };

  const handleButtonClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleClick();
  };

  return (
    <motion.div
      whileHover={{ scale: 1.02, y: -2 }}
      whileTap={{ scale: 0.98 }}
      className={cn(
        "group relative flex flex-col items-center rounded-xl border bg-card transition-all cursor-pointer",
        sizes.card,
        "hover:shadow-lg hover:border-primary/30",
        isComingSoon && "border-dashed",
        isInstalled && "ring-1 ring-primary/20",
      )}
      onClick={handleClick}
    >
      {/* Installed badge */}
      {isInstalled && (
        <div className="absolute -top-1.5 -right-1.5">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-3 w-3" />
          </div>
        </div>
      )}

      {/* Subtle status corner badge — replaces the blur overlay so the tile
          stays clickable and informative. */}
      {(isComingSoon || (isLocked && !isInstalled)) && (
        <div className="absolute top-2 left-2 flex items-center gap-1 rounded-md bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground backdrop-blur-sm">
          {isComingSoon ? (
            <>
              <Clock className="h-3 w-3" />
              Coming soon
            </>
          ) : (
            <>
              <Lock className="h-3 w-3" />
              {lockedLabel || "Access required"}
            </>
          )}
        </div>
      )}

      {/* Icon with colored background */}
      <div
        className={cn(
          "flex items-center justify-center rounded-xl transition-transform",
          sizes.iconContainer,
          "group-hover:scale-105"
        )}
        style={{ 
          backgroundColor: `${app.color}15`,
          color: app.color,
        }}
      >
        <AppIcon className={sizes.icon} />
      </div>

      {/* App name */}
      <h3 className={cn(
        "font-semibold text-center text-foreground line-clamp-1",
        isMobile ? "mt-1.5" : "mt-3",
        sizes.name
      )}>
        {app.name}
      </h3>

      {/* Description - hidden on mobile */}
      {shouldShowDescription && (
        <p className={cn(
          "mt-1 text-center text-muted-foreground line-clamp-2",
          sizes.description
        )}>
          {app.description}
        </p>
      )}

      {/* Action button — every state has a clear, distinct CTA */}
      <div className={cn("mt-auto w-full", isMobile ? "pt-1.5" : "pt-3")}>
        {isComingSoon ? (
          <Button
            variant="outline"
            size="sm"
            className={cn("w-full", sizes.button)}
            onClick={handleButtonClick}
          >
            <Clock className="mr-1.5 h-3.5 w-3.5" />
            Learn more
          </Button>
        ) : isLocked && !isInstalled ? (
          <Button
            variant="outline"
            size="sm"
            className={cn("w-full", sizes.button)}
            onClick={handleButtonClick}
          >
            <Lock className="mr-1.5 h-3.5 w-3.5" />
            Request access
          </Button>
        ) : lifecycleAction && !isInstalled ? (
          <Button
            variant="default"
            size="sm"
            className={cn("w-full", sizes.button)}
            onClick={(e) => { e.stopPropagation(); void lifecycleAction.onClick(); }}
            disabled={lifecycleAction.disabled}
          >
            {lifecycleAction.label}
          </Button>
        ) : (
          <Button
            variant={isInstalled ? "secondary" : "default"}
            size="sm"
            className={cn("w-full", sizes.button)}
            onClick={handleButtonClick}
          >
            {isInstalled ? (
              <>
                Open
                {!isMobile && <ArrowRight className="ml-1.5 h-3.5 w-3.5" />}
              </>
            ) : (
              <>
                {!isMobile && <Download className="mr-1.5 h-3.5 w-3.5" />}
                Install
              </>
            )}
          </Button>
        )}
      </div>
    </motion.div>
  );
}
