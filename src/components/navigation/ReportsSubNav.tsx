/**
 * ReportsSubNav Component
 * 
 * Simplified sub-navigation bar for report pages when nested inside
 * another app's layout (e.g., Finance > Financial Reports).
 * 
 * Shows only the report page links as horizontal tabs without:
 * - App switcher
 * - Theme toggle
 * - Notification bell
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AppDefinition } from "@/lib/apps/types";

interface ReportsSubNavProps {
  app: AppDefinition;
  /** The base path prefix from the parent app (e.g., "/finance/reports") */
  parentBasePath?: string;
}

export function ReportsSubNav({ app, parentBasePath }: ReportsSubNavProps) {
  const location = useLocation();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const visibleModules = app.modules.filter(m => !m.hidden);

  // Determine the effective base path for links
  const basePath = parentBasePath || app.basePath;

  // Check scroll state
  const checkScrollState = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const { scrollLeft, scrollWidth, clientWidth } = container;
    setCanScrollLeft(scrollLeft > 5);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 5);
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const timeoutId = setTimeout(checkScrollState, 100);
    container.addEventListener("scroll", checkScrollState);
    const resizeObserver = new ResizeObserver(checkScrollState);
    resizeObserver.observe(container);
    return () => {
      clearTimeout(timeoutId);
      container.removeEventListener("scroll", checkScrollState);
      resizeObserver.disconnect();
    };
  }, [checkScrollState, visibleModules.length]);

  const handleScrollLeft = () => {
    scrollContainerRef.current?.scrollBy({ left: -200, behavior: "smooth" });
  };

  const handleScrollRight = () => {
    scrollContainerRef.current?.scrollBy({ left: 200, behavior: "smooth" });
  };

  // Determine active module by matching current path
  const getIsActive = (modulePath: string) => {
    const fullPath = `${basePath}${modulePath}`;
    // Exact match for root module (empty path)
    if (modulePath === "" || modulePath === "/") {
      return location.pathname === basePath || location.pathname === `${basePath}/`;
    }
    return location.pathname.startsWith(fullPath);
  };

  return (
    <div className="relative z-30 w-full border-b bg-muted/30 backdrop-blur supports-[backdrop-filter]:bg-muted/20">
      <div className="px-4">
        <div className="relative flex items-center w-full">
          {/* Left Arrow */}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "absolute left-0 z-10 h-7 w-7 rounded-full bg-background/90 hover:bg-muted shadow-sm border transition-opacity duration-200",
              canScrollLeft ? "opacity-100" : "opacity-0 pointer-events-none"
            )}
            onClick={handleScrollLeft}
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Scroll left</span>
          </Button>

          {/* Scrollable Tabs */}
          <div
            ref={scrollContainerRef}
            className="flex items-center gap-1 overflow-x-auto scrollbar-hide px-8 py-1.5"
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
          >
            {visibleModules.map((module) => {
              const isActive = getIsActive(module.path);
              const fullPath = `${basePath}${module.path}`;

              return (
                <Link
                  key={module.id}
                  to={fullPath}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                >
                  <module.icon className="h-3.5 w-3.5" />
                  <span>{module.name}</span>
                </Link>
              );
            })}
          </div>

          {/* Right Arrow */}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "absolute right-0 z-10 h-7 w-7 rounded-full bg-background/90 hover:bg-muted shadow-sm border transition-opacity duration-200",
              canScrollRight ? "opacity-100" : "opacity-0 pointer-events-none"
            )}
            onClick={handleScrollRight}
          >
            <ChevronRight className="h-4 w-4" />
            <span className="sr-only">Scroll right</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
