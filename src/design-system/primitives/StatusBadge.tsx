/**
 * StatusBadge — the single approved way to render a status pill.
 * Variants are intent-driven, never module-specific.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

const toneStyles: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  warning: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  danger: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300",
  accent: "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
};

interface StatusBadgeProps {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}

export function StatusBadge({
  children,
  tone = "neutral",
  className,
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        toneStyles[tone],
        className,
      )}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-current opacity-70"
      />
      {children}
    </span>
  );
}
