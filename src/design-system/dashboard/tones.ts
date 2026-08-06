/**
 * Dashboard tones — the shared status vocabulary for every dashboard
 * primitive. Same six intents as StatusBadge, expressed as text / surface
 * / bar classes so KPIs, gauges and health lists never invent colours.
 */
export type DashboardTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

export const TONE_TEXT: Record<DashboardTone, string> = {
  neutral: "text-foreground",
  info: "text-blue-600 dark:text-blue-400",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  accent: "text-primary",
};

export const TONE_SURFACE: Record<DashboardTone, string> = {
  neutral: "bg-muted",
  info: "bg-blue-500/10",
  success: "bg-success/10",
  warning: "bg-warning/15",
  danger: "bg-destructive/10",
  accent: "bg-primary/10",
};

export const TONE_BAR: Record<DashboardTone, string> = {
  neutral: "bg-muted-foreground/40",
  info: "bg-blue-500",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  accent: "bg-primary",
};

/** Threshold helper: percentage → tone, high values being bad. */
export function utilisationTone(pct: number): DashboardTone {
  if (pct >= 95) return "danger";
  if (pct >= 85) return "warning";
  if (pct >= 60) return "info";
  return "success";
}
