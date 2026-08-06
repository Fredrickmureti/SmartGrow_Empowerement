/**
 * EntityPreview — the ONLY approved shape for a warehouse master/detail
 * side pane (ADR 0122).
 *
 * A preview answers exactly one question: **"What is this, and what can I
 * do about it right now?"** It shows identity, operational state, a small
 * metric strip, whatever open work exists, and at most a handful of
 * one-click acts. It ends with a single door into the entity's workspace.
 *
 * A preview is read-only by contract. It never renders form fields, never
 * hosts configuration, never grows tabs, never becomes a dashboard. The
 * moment a surface needs any of those, it belongs on the entity's
 * workspace route — which is why every preview carries `workspaceHref`.
 *
 * Enforced by `src/test/architecture/warehouse-preview-vs-workspace.test.ts`.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/design-system";
import { cn } from "@/lib/utils";

export interface PreviewMetric {
  label: string;
  value: string;
  tone?: "default" | "danger" | "warning";
}

interface EntityPreviewProps {
  /** Small kind label — "Bin", "Trailer", "Packaging". */
  eyebrow?: ReactNode;
  /** Breadcrumb-ish context line above the title. */
  context?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** StatusBadge instance. */
  status?: ReactNode;
  /** Up to four numbers a supervisor scans in one glance. */
  metrics?: PreviewMetric[];
  /** Immediate acts only — print, block, move. Never "save". */
  actions?: ReactNode;
  /** Route to the full management workspace for this entity. */
  workspaceHref?: string;
  workspaceLabel?: string;
  /** Read-only body: open work, recent activity, summary facts. */
  children?: ReactNode;
  className?: string;
}

export function EntityPreview({
  eyebrow,
  context,
  title,
  subtitle,
  status,
  metrics,
  actions,
  workspaceHref,
  workspaceLabel = "Open workspace",
  children,
  className,
}: EntityPreviewProps) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="space-y-2 border-b p-4">
        {context && (
          <div className="truncate text-xs uppercase tracking-wide text-muted-foreground">
            {context}
          </div>
        )}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {eyebrow && (
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {eyebrow}
              </p>
            )}
            <h2 className="truncate text-xl font-semibold">{title}</h2>
            {subtitle && (
              <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {status}
        </div>
        {actions && <div className="flex flex-wrap gap-2 pt-1">{actions}</div>}
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
        {metrics && metrics.length > 0 && (
          <div className="grid min-w-0 grid-cols-2 gap-3">
            {metrics.map((m) => (
              <div key={m.label} className="min-w-0 rounded-md border p-2">
                <div className="truncate text-xs text-muted-foreground">{m.label}</div>
                <div
                  className={cn(
                    "truncate text-lg font-semibold",
                    m.tone === "danger" && "text-destructive",
                  )}
                >
                  {m.value}
                </div>
              </div>
            ))}
          </div>
        )}
        {children}
      </div>

      {workspaceHref && (
        <div className="border-t p-3">
          <Button asChild className="w-full" variant="outline">
            <Link to={workspaceHref}>
              {workspaceLabel} <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

/** Consistent "nothing selected yet" pane. */
export function EntityPreviewEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState title={title} description={description} />
    </div>
  );
}

/** Small read-only fact row used inside preview bodies. */
export function PreviewFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-medium">{value}</span>
    </div>
  );
}

export default EntityPreview;
