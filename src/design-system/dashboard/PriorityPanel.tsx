/**
 * PriorityPanel — the ranked "do this first" stack. Module-agnostic:
 * anything that can produce (severity, title, impact, action) can feed it.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { StatusBadge } from "../primitives/StatusBadge";
import { type DashboardTone } from "./tones";

export interface PriorityItem {
  id: string;
  title: ReactNode;
  detail?: ReactNode;
  /** Quantified impact, e.g. "18 tasks" or "4 h late". */
  impact?: ReactNode;
  tone?: DashboardTone;
  severityLabel?: string;
  to?: string;
}

interface PriorityPanelProps {
  items: PriorityItem[];
  className?: string;
}

export function PriorityPanel({ items, className }: PriorityPanelProps) {
  return (
    <ol className={cn("min-w-0 divide-y", className)}>
      {items.map((item, index) => {
        const body = (
          <div className="flex min-w-0 items-start gap-3 py-2.5">
            <span className="mt-0.5 w-4 shrink-0 text-[length:var(--ds-text-caption)] font-semibold tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{item.title}</div>
              {item.detail && (
                <div className="truncate text-[length:var(--ds-text-caption)] text-muted-foreground">
                  {item.detail}
                </div>
              )}
            </div>
            {item.impact && (
              <span className="shrink-0 text-sm font-semibold tabular-nums">{item.impact}</span>
            )}
            <StatusBadge tone={item.tone ?? "neutral"} className="shrink-0">
              {item.severityLabel ?? item.tone ?? "info"}
            </StatusBadge>
          </div>
        );
        return (
          <li key={item.id} className="min-w-0">
            {item.to ? (
              <Link
                to={item.to}
                className="block rounded-[var(--ds-radius-sm)] px-1 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
}
