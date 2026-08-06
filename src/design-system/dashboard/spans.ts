/**
 * Span model — the ONLY place a dashboard turns semantics into columns.
 *
 * Pages declare intent (`half`, `third`, …); this map resolves it against
 * the canvas grid (1 col → 2 cols → 12 cols, driven by the `page`
 * container query). No page may hand-author `grid-cols-*`.
 */

export type DashboardSpan =
  | "quarter"
  | "third"
  | "half"
  | "two-thirds"
  | "full";

/** Grid applied by every DashboardBand. */
export const DASHBOARD_GRID =
  "grid min-w-0 max-w-full grid-cols-1 @2xl/page:grid-cols-2 @4xl/page:grid-cols-12";

export const SPAN_CLASS: Record<DashboardSpan, string> = {
  quarter: "col-span-1 @4xl/page:col-span-3",
  third: "col-span-1 @4xl/page:col-span-4",
  half: "col-span-1 @4xl/page:col-span-6",
  "two-thirds": "col-span-1 @2xl/page:col-span-2 @4xl/page:col-span-8",
  full: "col-span-1 @2xl/page:col-span-2 @4xl/page:col-span-12",
};

export function spanClass(span: DashboardSpan = "full"): string {
  return SPAN_CLASS[span] ?? SPAN_CLASS.full;
}
