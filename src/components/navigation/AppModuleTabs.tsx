/**
 * AppModuleTabs Component
 * 
 * Horizontal tab navigation for modules within an app.
 * Used in the AppTopNavbar for app workspace mode.
 * Includes scroll arrows for desktop users without trackpads.
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AppDefinition, ModuleDefinition } from "@/lib/apps/types";
import { useAppNavigation } from "@/hooks/useAppNavigation";

interface AppModuleTabsProps {
  app: AppDefinition;
  className?: string;
}

export function AppModuleTabs({ app, className }: AppModuleTabsProps) {
  const { currentModule, getAccessibleModules } = useAppNavigation();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  
  // Get visible modules (not hidden)
  const visibleModules = getAccessibleModules(app).filter(m => !m.hidden);

  // Check scroll state
  const checkScrollState = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    setCanScrollLeft(scrollLeft > 5);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 5);
  }, []);

  // Set up scroll state checking
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // Initial check with delay to ensure layout is complete
    const timeoutId = setTimeout(checkScrollState, 100);

    // Check on scroll
    container.addEventListener("scroll", checkScrollState);
    
    // Check on resize
    const resizeObserver = new ResizeObserver(checkScrollState);
    resizeObserver.observe(container);

    return () => {
      clearTimeout(timeoutId);
      container.removeEventListener("scroll", checkScrollState);
      resizeObserver.disconnect();
    };
  }, [checkScrollState, visibleModules.length]);

  // Scroll handlers
  const handleScrollLeft = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollBy({ left: -200, behavior: "smooth" });
  };

  const handleScrollRight = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollBy({ left: 200, behavior: "smooth" });
  };

  return (
    <div className={cn("relative flex items-center w-full", className)}>
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

      {/* Scrollable Content */}
      <div 
        ref={scrollContainerRef}
        className="flex items-center gap-1 overflow-x-auto scrollbar-hide px-8"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {visibleModules.map((module) => (
          <ModuleTab 
            key={module.id} 
            app={app}
            module={module} 
            isActive={currentModule?.id === module.id}
          />
        ))}
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
  );
}

interface ModuleTabProps {
  app: AppDefinition;
  module: ModuleDefinition;
  isActive: boolean;
}

function ModuleTab({ app, module, isActive }: ModuleTabProps) {
  const fullPath = `${app.basePath}${module.path}`;

  return (
    <Link
      to={fullPath}
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md whitespace-nowrap transition-colors",
        isActive
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent"
      )}
    >
      <span>{module.name}</span>
      {module.badge && (
        <Badge 
          variant={isActive ? "secondary" : "outline"} 
          className="text-[10px] px-1.5 py-0"
        >
          {module.badge}
        </Badge>
      )}
    </Link>
  );
}
