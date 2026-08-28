/**
 * Tone palette — the single source of truth for status colour across the ERP.
 *
 * StatusBadge owns the *pill* rendering; this module owns the same intents
 * when they have to be expressed as bare text, an icon tint, a border or a
 * fill (progress bars, capacity meters, timeline chips, inline check marks).
 *
 * Modules must never write `text-emerald-600 dark:text-emerald-400` inline —
 * that is how eight slightly different greens end up in one product. Import
 * `toneText(tone)` (or the sibling helpers) instead, so retinting the whole
 * ERP is a one-file change.
 */

export type Tone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  /** Between warning and danger: breached, but not yet unrecoverable. */
  | "alert"
  | "danger"
  | "accent";

const TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  info: "text-blue-600 dark:text-blue-400",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  alert: "text-orange-600 dark:text-orange-400",
  danger: "text-destructive",
  accent: "text-violet-600 dark:text-violet-400",
};

const BORDER: Record<Tone, string> = {
  neutral: "border-border",
  info: "border-blue-500/30",
  success: "border-emerald-500/30",
  warning: "border-amber-500/30",
  alert: "border-orange-500/40",
  danger: "border-destructive/40",
  accent: "border-violet-500/30",
};

/** Low-opacity wash for rows/cards that must read as "this one matched". */
const SURFACE: Record<Tone, string> = {
  neutral: "bg-muted/40",
  info: "bg-blue-500/5",
  success: "bg-emerald-500/5",
  warning: "bg-amber-500/5",
  alert: "bg-orange-500/5",
  danger: "bg-destructive/5",
  accent: "bg-violet-500/5",
};

/** Solid fill for meters and progress bars. */
const FILL: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  info: "bg-blue-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  alert: "bg-orange-500",
  danger: "bg-destructive",
  accent: "bg-violet-500",
};

const RING: Record<Tone, string> = {
  neutral: "ring-border",
  info: "ring-blue-500/30",
  success: "ring-emerald-500/30",
  warning: "ring-amber-500/30",
  alert: "ring-orange-500/30",
  danger: "ring-destructive/40",
  accent: "ring-violet-500/30",
};

export const toneText = (tone: Tone) => TEXT[tone];
export const toneBorder = (tone: Tone) => BORDER[tone];
export const toneSurface = (tone: Tone) => SURFACE[tone];
export const toneFill = (tone: Tone) => FILL[tone];
export const toneRing = (tone: Tone) => RING[tone];

/**
 * Map the SummaryStatCard tone vocabulary (ok/warn/bad/neutral) onto the
 * StatusBadge one, so a page never has to keep two mental models.
 */
export function toneFromStat(stat: "ok" | "warn" | "bad" | "neutral"): Tone {
  if (stat === "ok") return "success";
  if (stat === "warn") return "warning";
  if (stat === "bad") return "danger";
  return "neutral";
}
