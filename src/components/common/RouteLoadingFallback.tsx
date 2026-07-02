/**
 * Route Loading Fallback Component
 * 
 * Displays a branded loading state while lazy-loaded routes are being fetched.
 * Used as the fallback for React.Suspense boundaries around lazy routes.
 */

import React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface RouteLoadingFallbackProps {
  /** Name of the module being loaded (for context) */
  module?: string;
  /** Additional CSS classes */
  className?: string;
  /** Show minimal loader without module name */
  minimal?: boolean;
}

export const RouteLoadingFallback = React.forwardRef<HTMLDivElement, RouteLoadingFallbackProps>(function RouteLoadingFallback(
  {
    module,
    className,
    minimal = false,
  },
  ref,
) {
  if (minimal) {
    return (
      <div
        ref={ref}
        className={cn(
          "flex items-center justify-center min-h-[200px]",
          className,
        )}
      >
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-col items-center justify-center min-h-screen bg-background",
        className,
      )}
    >
      <div className="flex flex-col items-center gap-4 animate-in fade-in duration-300">
        <div className="relative">
          <div className="h-12 w-12 rounded-full border-4 border-muted" />
          <div className="absolute inset-0 h-12 w-12 rounded-full border-4 border-primary border-t-transparent animate-spin" />
        </div>

        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            {module ? `Loading ${module}...` : "Loading..."}
          </p>
        </div>
      </div>
    </div>
  );
});

/**
 * Inline loading fallback for smaller components
 */
export const InlineLoadingFallback = React.forwardRef<HTMLDivElement, { className?: string }>(function InlineLoadingFallback(
  { className },
  ref,
) {
  return (
    <div ref={ref} className={cn("flex items-center justify-center py-8", className)}>
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
});

export default RouteLoadingFallback;
