/**
 * PageBody — the vertical container for page content below the PageHeader.
 * Enforces consistent padding, max-width, and inter-section rhythm.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageBodyProps {
  children: ReactNode;
  /** Stretch full width (e.g. for kanban boards). Default false. */
  fullWidth?: boolean;
  className?: string;
}

export function PageBody({ children, fullWidth, className }: PageBodyProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full flex-col gap-6 px-0 py-6 sm:px-6",
        !fullWidth && "mx-auto w-full max-w-[var(--ds-page-max-width)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
