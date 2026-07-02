/**
 * Item layout templates — extensible replacement for the 3-way
 * `'single-line' | 'two-lines' | 'tabular'` enum that was hardcoded in
 * `buildDocumentEscPos`. New layouts are added by exporting another
 * `LayoutTemplate` from this file (or a sibling) and registering it in
 * `LAYOUT_REGISTRY`.
 */

import type { ColumnSpec } from "../engine/ColumnLayout";

export type LayoutId =
  | "compact"        // formerly 'single-line'
  | "detailed"       // formerly 'two-lines'
  | "tabular"        // grid (no SKU)
  | "tabular_sku";   // grid with SKU column

export interface LayoutContext {
  showSku: boolean;
  showQty: boolean;
  showUnitPrice: boolean;
  showDiscount: boolean;
  showTaxBreakdown: boolean;
  showTaxRate: boolean;
  showModifiers: boolean;
  truncateLongNames: boolean;
  maxNameLen: number;
}

export interface LayoutTemplate {
  id: LayoutId;
  label: string;
  /** Below this column count the layout is considered too cramped (callers may downgrade). */
  minColumns: number;
  /** Section heading (null = no heading row). */
  heading: string | null;
  /** Column specs as a function of context; omit columns that should not appear. */
  columns: (ctx: LayoutContext) => ColumnSpec[];
  /** Whether to render a column-header row (Tabular variants do; Compact/Detailed don't). */
  showHeader: boolean;
  /**
   * Per-item rendering shape:
   *   'single-row'    → one logical row (may wrap into multiple physical rows
   *                     when name wrap is enabled).
   *   'two-row'       → name row, then a "qty x unit … total" sub-row.
   */
  itemShape: "single-row" | "two-row";
}

const COMPACT: LayoutTemplate = {
  id: "compact",
  label: "Compact",
  minColumns: 24,
  heading: "Items",
  showHeader: false,
  itemShape: "single-row",
  columns: (ctx) => {
    const cols: ColumnSpec[] = [];
    if (ctx.showQty) cols.push({ key: "qty", header: "Qty", width: 4, align: "left" });
    if (ctx.showSku) cols.push({ key: "sku", header: "SKU", width: 8, align: "left" });
    cols.push({ key: "name", header: "Item", width: { fr: 1, min: 8 }, align: "left", wrap: !ctx.truncateLongNames });
    cols.push({ key: "total", header: "Total", width: 10, align: "right" });
    return cols;
  },
};

const DETAILED: LayoutTemplate = {
  id: "detailed",
  label: "Detailed",
  minColumns: 24,
  heading: "Items",
  showHeader: false,
  itemShape: "two-row",
  columns: (_ctx) => [
    { key: "name", header: "Item", width: { fr: 1, min: 12 }, align: "left", wrap: true },
  ],
};

const TABULAR: LayoutTemplate = {
  id: "tabular",
  label: "Tabular",
  minColumns: 32,
  heading: null,
  showHeader: true,
  itemShape: "single-row",
  columns: (ctx) => [
    { key: "name", header: "Item", width: { fr: 1, min: 10 }, align: "left", wrap: true },
    ...(ctx.showQty ? [{ key: "qty", header: "Qty", width: 5, align: "right" as const }] : []),
    { key: "total", header: "Total", width: 10, align: "right" },
  ],
};

const TABULAR_SKU: LayoutTemplate = {
  id: "tabular_sku",
  label: "Tabular with SKU",
  minColumns: 40,
  heading: null,
  showHeader: true,
  itemShape: "single-row",
  columns: (ctx) => [
    { key: "sku", header: "SKU", width: 8, align: "left" },
    { key: "name", header: "Item", width: { fr: 1, min: 10 }, align: "left", wrap: true },
    ...(ctx.showQty ? [{ key: "qty", header: "Qty", width: 5, align: "right" as const }] : []),
    { key: "total", header: "Total", width: 10, align: "right" },
  ],
};

export const LAYOUT_REGISTRY: Record<LayoutId, LayoutTemplate> = {
  compact: COMPACT,
  detailed: DETAILED,
  tabular: TABULAR,
  tabular_sku: TABULAR_SKU,
};

/** Map the legacy three-value enum + show_item_sku flag to a layout id. */
export function resolveLegacyLayout(
  format: "single-line" | "two-lines" | "tabular" | undefined,
  showSku: boolean,
): LayoutId {
  if (format === "two-lines") return "detailed";
  if (format === "tabular") return showSku ? "tabular_sku" : "tabular";
  return "compact";
}

/**
 * Receipt overhaul Phase 2 — minimum content width a layout can render
 * without squeezing flex columns below their `min`. Sum of fixed widths +
 * sum of min-fr widths + (n-1) single-space gaps.
 */
export function layoutMinContentWidth(layoutId: LayoutId, ctx: LayoutContext): number {
  const cols = LAYOUT_REGISTRY[layoutId].columns(ctx);
  if (cols.length === 0) return 0;
  let sum = 0;
  for (const c of cols) {
    if (typeof c.width === "number") sum += Math.max(1, Math.floor(c.width));
    else sum += Math.max(1, c.width.min ?? 1);
  }
  return sum + Math.max(0, cols.length - 1);
}

/** Downgrade chain — narrower layouts later. */
const DOWNGRADE_CHAIN: LayoutId[] = ["tabular_sku", "tabular", "compact", "detailed"];

/**
 * Receipt overhaul Phase 2 — pick the densest layout from the downgrade
 * chain that physically fits the printer's content width.
 *
 * Always falls back to `detailed` (single-column wrap) so even 40mm /
 * 24-col paper produces a clean, professional print instead of a squeezed
 * tabular grid that visually overflows.
 */
export function pickFittingLayout(
  preferred: LayoutId,
  ctx: LayoutContext,
  contentWidth: number,
): { layoutId: LayoutId; downgraded: boolean } {
  if (layoutMinContentWidth(preferred, ctx) <= contentWidth) {
    return { layoutId: preferred, downgraded: false };
  }
  // Walk the chain starting from the preferred layout's position so we
  // never UPGRADE (e.g. don't promote 'detailed' → 'tabular' on wide paper).
  const startIdx = Math.max(0, DOWNGRADE_CHAIN.indexOf(preferred));
  for (let i = startIdx + 1; i < DOWNGRADE_CHAIN.length; i++) {
    const cand = DOWNGRADE_CHAIN[i];
    if (layoutMinContentWidth(cand, ctx) <= contentWidth) {
      return { layoutId: cand, downgraded: true };
    }
  }
  return { layoutId: "detailed", downgraded: true };
}

