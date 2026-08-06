/**
 * HealthList — multi-entity status roll-up (equipment, zones, integrations,
 * queues). One row per entity: name, quiet meta, tone-coded value.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { TONE_TEXT, type DashboardTone } from "./tones";

export interface HealthListItem {
  id: string;
  label: ReactNode;
  meta?: ReactNode;
  value?: ReactNode;
  tone?: DashboardTone;
  to?: string;
}

interface HealthListProps {
  items: HealthListItem[];
  className?: string;
}

export function HealthList({ items, className }: HealthListProps) {
  return (
    <ul className={cn("min-w-0 divide-y", className)}>
      {items.map((item) => {
        const row = (
          <div className="flex min-w-0 items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{item.label}</div>
              {item.meta && (
                <div className="truncate text-[length:var(--ds-text-micro)] text-muted-foreground">
                  {item.meta}
                </div>
              )}
            </div>
            {item.value !== undefined && (
              <span
                className={cn(
                  "shrink-0 text-sm font-semibold tabular-nums",
                  TONE_TEXT[item.tone ?? "neutral"],
                )}
              >
                {item.value}
              </span>
            )}
          </div>
        );
        return (
          <li key={item.id} className="min-w-0">
            {item.to ? (
              <Link
                to={item.to}
                className="block rounded-[var(--ds-radius-sm)] px-1 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {row}
              </Link>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}
