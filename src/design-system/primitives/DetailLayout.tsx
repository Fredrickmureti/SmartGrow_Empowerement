/**
 * DetailLayout — the two-column record view used by every entity detail
 * page (Employee, Invoice, Product, Project…). Main column on the left,
 * meta/aside column on the right that drops below on narrow screens.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface DetailLayoutProps {
  main: ReactNode;
  aside?: ReactNode;
  className?: string;
}

export function DetailLayout({ main, aside, className }: DetailLayoutProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]",
        className,
      )}
    >
      <div className="min-w-0 space-y-6">{main}</div>
      {aside && <aside className="space-y-4">{aside}</aside>}
    </div>
  );
}
