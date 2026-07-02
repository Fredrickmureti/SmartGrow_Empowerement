/**
 * PageTabs — the ONLY allowed in-page tab strip.
 *
 * Renders directly under PageHeader. Replaces every ad-hoc *SubNav.
 * Tabs are URL-routed (Link), not state-only, so deep links survive.
 *
 * Rule: never nest PageTabs inside PageTabs. If you need a second level,
 * promote the second axis into a sidebar group, not another horizontal strip.
 */
import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

export interface PageTab {
  to: string;
  label: string;
  /** Match exactly. Defaults to false (startsWith). */
  end?: boolean;
  badge?: string | number;
  disabled?: boolean;
}

interface PageTabsProps {
  tabs: PageTab[];
  className?: string;
}

export function PageTabs({ tabs, className }: PageTabsProps) {
  const { pathname } = useLocation();
  return (
    <nav
      role="tablist"
      aria-label="Section"
      className={cn(
        "mb-6 -mt-2 flex items-center gap-1 border-b border-border overflow-x-auto",
        className,
      )}
    >
      {tabs.map((t) => {
        const active = t.end ? pathname === t.to : pathname.startsWith(t.to);
        return (
          <Link
            key={t.to}
            to={t.to}
            role="tab"
            aria-selected={active}
            aria-disabled={t.disabled || undefined}
            tabIndex={t.disabled ? -1 : 0}
            className={cn(
              "relative inline-flex items-center gap-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              "border-b-2 -mb-px",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
              t.disabled && "pointer-events-none opacity-50",
            )}
          >
            {t.label}
            {t.badge !== undefined && (
              <span className="inline-flex items-center justify-center rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground min-w-5">
                {t.badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

export default PageTabs;
