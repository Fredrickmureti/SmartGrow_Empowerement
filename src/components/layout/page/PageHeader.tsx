/**
 * PageHeader — single source of truth for a page's title bar.
 *
 * Slots:
 *   title         — page name (required)
 *   description   — one-line subtitle
 *   eyebrow       — small uppercase label above the title (e.g. module name)
 *   breadcrumbs   — optional breadcrumb node (rendered above eyebrow)
 *   actions       — primary action(s) on the right
 *   scope         — slot for DeclaredScopeChip / context chips
 *   meta          — secondary inline metadata under the title
 *
 * Every page composes exactly one <PageHeader>. No bespoke header markup.
 */
import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  breadcrumbs?: ReactNode;
  actions?: ReactNode;
  scope?: ReactNode;
  meta?: ReactNode;
  /** Sticky on scroll inside the page scroll container. */
  sticky?: boolean;
  className?: string;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  breadcrumbs,
  actions,
  scope,
  meta,
  sticky = false,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-3 border-b border-border pb-4 mb-6",
        sticky && "sticky top-0 z-20 bg-background pt-4",
        className,
      )}
    >
      {breadcrumbs && (
        <div className="text-sm text-muted-foreground">{breadcrumbs}</div>
      )}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium mb-1">
              {eyebrow}
            </div>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {title}
            </h1>
            {scope}
          </div>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
              {description}
            </p>
          )}
          {meta && (
            <div className="mt-2 flex items-center gap-3 flex-wrap text-sm text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>
        )}
      </div>
    </header>
  );
}

export default PageHeader;
