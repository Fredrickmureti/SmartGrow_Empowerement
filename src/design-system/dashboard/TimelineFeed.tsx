/**
 * TimelineFeed — reverse-chronological event stream with relative time.
 * The dashboard proof that work is actually moving.
 */
import type { ReactNode } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/utils";
import { TONE_BAR, type DashboardTone } from "./tones";

export interface TimelineEntry {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** ISO timestamp or Date. */
  at?: string | Date | null;
  tone?: DashboardTone;
}

interface TimelineFeedProps {
  entries: TimelineEntry[];
  className?: string;
}

function relative(at?: string | Date | null): string {
  if (!at) return "";
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "";
  return `${formatDistanceToNowStrict(d)} ago`;
}

export function TimelineFeed({ entries, className }: TimelineFeedProps) {
  return (
    <ol className={cn("min-w-0 space-y-3", className)}>
      {entries.map((e) => (
        <li key={e.id} className="flex min-w-0 gap-3">
          <span
            aria-hidden
            className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", TONE_BAR[e.tone ?? "neutral"])}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium">{e.title}</span>
              <time className="shrink-0 text-[length:var(--ds-text-micro)] tabular-nums text-muted-foreground">
                {relative(e.at)}
              </time>
            </div>
            {e.description && (
              <p className="truncate text-[length:var(--ds-text-caption)] text-muted-foreground">
                {e.description}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
