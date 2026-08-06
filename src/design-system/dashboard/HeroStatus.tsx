/**
 * HeroStatus — the single verdict at the top of an operational dashboard:
 * what state are we in, why, and what is the one thing to do about it.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "../primitives/StatusBadge";
import { TONE_SURFACE, TONE_TEXT, type DashboardTone } from "./tones";

interface HeroStatusProps {
  /** Short verdict, e.g. "Flowing" / "At risk" / "Blocked". */
  state: ReactNode;
  tone?: DashboardTone;
  /** Why we are in this state. One sentence. */
  reason?: ReactNode;
  /** The worst contributor, rendered as a quiet caption. */
  detail?: ReactNode;
  /** Primary action / drill affordance. */
  actions?: ReactNode;
  className?: string;
}

export function HeroStatus({
  state,
  tone = "neutral",
  reason,
  detail,
  actions,
  className,
}: HeroStatusProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-w-0 max-w-full flex-wrap items-center justify-between gap-x-6 gap-y-3",
        "rounded-[var(--ds-radius-lg)] border px-4 py-4 sm:px-5",
        TONE_SURFACE[tone],
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-[18rem]">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={cn(
              "text-[length:var(--ds-text-title)] font-semibold leading-tight",
              TONE_TEXT[tone],
            )}
          >
            {state}
          </span>
          <StatusBadge tone={tone}>live</StatusBadge>
        </div>
        {reason && <p className="mt-1 text-sm text-foreground/80">{reason}</p>}
        {detail && (
          <p className="mt-0.5 text-[length:var(--ds-text-caption)] text-muted-foreground">
            {detail}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
