/**
 * ActionBar — the right-side cluster used inside PageHeader / Section
 * headers. Wraps gracefully on narrow screens.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ActionBarProps {
  children: ReactNode;
  className?: string;
}

export function ActionBar({ children, className }: ActionBarProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {children}
    </div>
  );
}
