import * as React from "react";
import { useRef, useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TabsList } from "./tabs";
import { cn } from "@/lib/utils";

interface ScrollableTabsListProps extends React.ComponentPropsWithoutRef<typeof TabsList> {
  children: React.ReactNode;
}

export function ScrollableTabsList({ children, className, ...props }: ScrollableTabsListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener("scroll", checkScroll, { passive: true });
    const ro = new ResizeObserver(checkScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", checkScroll);
      ro.disconnect();
    };
  }, [checkScroll]);

  const scroll = (direction: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction === "left" ? -150 : 150, behavior: "smooth" });
  };

  return (
    <div className="relative flex items-center sm:block">
      {/* Left arrow - mobile only */}
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => scroll("left")}
          className="sm:hidden absolute left-0 z-10 flex items-center justify-center h-8 w-7 bg-gradient-to-r from-muted via-muted to-transparent rounded-l-md"
          aria-label="Scroll tabs left"
        >
          <ChevronLeft className="h-4 w-4 text-foreground" />
        </button>
      )}

      <div ref={scrollRef} className="overflow-hidden w-full">
        <TabsList className={cn("w-full justify-start", className)} {...props}>
          {children}
        </TabsList>
      </div>

      {/* Right arrow - mobile only */}
      {canScrollRight && (
        <button
          type="button"
          onClick={() => scroll("right")}
          className="sm:hidden absolute right-0 z-10 flex items-center justify-center h-8 w-7 bg-gradient-to-l from-muted via-muted to-transparent rounded-r-md"
          aria-label="Scroll tabs right"
        >
          <ChevronRight className="h-4 w-4 text-foreground" />
        </button>
      )}
    </div>
  );
}
