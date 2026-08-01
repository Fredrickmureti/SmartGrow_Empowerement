/**
 * Line-item column profiles — the ONE authoritative definition of which
 * line-item columns a document shows, in what order, with what alignment
 * and what relative width.
 *
 * Enterprise Document Presentation Architecture (ADR-0084 follow-on):
 * line-item column decisions were previously duplicated in three unrelated
 * places — the A4 PDF `buildColumns()`, the thermal `drawLineItemsNarrow()`
 * and the POS `LayoutTemplate.columns()` functions. Presentation decisions
 * belong to the document definition, NOT to a renderer. This module is that
 * definition; renderers consume it and are responsible only for geometry
 * (points vs. character cells, wrapping, page breaks).
 *
 * ── PARITY CONTRACT ────────────────────────────────────────────────────────
 * This file is mirrored byte-for-byte at
 *   supabase/functions/_shared/documents/lineItemProfiles.ts
 * because the browser (Vite/TS) and edge (Deno) runtimes cannot share a
 * module graph. `src/test/architecture/line-item-profile-parity.test.ts`
 * fails the build if the two copies drift. Edit BOTH or neither.
 */

/** Medium-neutral media classes a document can be presented on. */
export type LineItemMediaClass = "a4" | "letter" | "thermal" | "label" | "email_html";

/** Logical line-item columns. Renderers must not invent keys outside this union. */
export type LineItemColumnKey =
  | "index"
  | "sku"
  | "description"
  | "qty"
  | "unit_price"
  | "tax"
  | "discount"
  | "amount";

export type LineItemAlign = "left" | "right" | "center";

export interface LineItemColumn {
  key: LineItemColumnKey;
  header: string;
  align: LineItemAlign;
  /**
   * Proportional width for continuous media (PDF/HTML). Renderers normalise
   * across the visible set — the absolute value carries no unit.
   */
  weight: number;
  /**
   * Preferred character-cell width for monospace media (thermal/label).
   * `null` means "flexible: absorb the remaining columns".
   */
  cells: number | null;
}

/**
 * Presentation flags for a document's line-item table. These come from the
 * document definition (template settings), never from renderer-local state.
 */
export interface LineItemProfileContext {
  showLineNumbers?: boolean;
  showSku?: boolean;
  showQuantity?: boolean;
  showUnitPrice?: boolean;
  showTax?: boolean;
  showDiscount?: boolean;
  /** Delivery-note style: suppress every monetary column regardless of flags. */
  hideAmounts?: boolean;
}

const DEFAULTS: Required<LineItemProfileContext> = {
  showLineNumbers: true,
  showSku: false,
  showQuantity: true,
  showUnitPrice: true,
  showTax: false,
  showDiscount: false,
  hideAmounts: false,
};

export function normaliseLineItemContext(
  ctx: LineItemProfileContext | undefined | null,
): Required<LineItemProfileContext> {
  const c = ctx ?? {};
  return {
    showLineNumbers: c.showLineNumbers !== false,
    showSku: c.showSku === true,
    showQuantity: c.showQuantity !== false,
    showUnitPrice: c.showUnitPrice !== false,
    showTax: c.showTax === true,
    showDiscount: c.showDiscount === true,
    hideAmounts: c.hideAmounts === true,
  };
}

/** Wide media (A4 / Letter / email HTML): the full accountant-style grid. */
function wideProfile(c: Required<LineItemProfileContext>): LineItemColumn[] {
  const cols: LineItemColumn[] = [];
  if (c.showLineNumbers) cols.push({ key: "index", header: "#", align: "left", weight: 4, cells: 3 });
  if (c.showSku) cols.push({ key: "sku", header: "SKU", align: "left", weight: 10, cells: 8 });
  cols.push({ key: "description", header: "Description", align: "left", weight: 40, cells: null });
  if (c.showQuantity) cols.push({ key: "qty", header: "Qty", align: "right", weight: 7, cells: 5 });
  if (!c.hideAmounts && c.showUnitPrice) {
    cols.push({ key: "unit_price", header: "Price", align: "right", weight: 12, cells: 9 });
  }
  if (!c.hideAmounts && c.showTax) {
    cols.push({ key: "tax", header: "Tax", align: "right", weight: 8, cells: 6 });
  }
  if (!c.hideAmounts && c.showDiscount) {
    cols.push({ key: "discount", header: "Disc", align: "right", weight: 8, cells: 6 });
  }
  if (!c.hideAmounts) {
    cols.push({ key: "amount", header: "Amount", align: "right", weight: 14, cells: 10 });
  }
  return cols;
}

/**
 * Narrow media (thermal / label): the multi-column grid is unreadable, so the
 * profile collapses to description + amount. Quantity and unit price are still
 * *selected* here — narrow renderers present them as an inline "qty x price"
 * sub-row rather than as their own columns.
 */
function narrowProfile(c: Required<LineItemProfileContext>): LineItemColumn[] {
  const cols: LineItemColumn[] = [];
  if (c.showSku) cols.push({ key: "sku", header: "SKU", align: "left", weight: 10, cells: 8 });
  cols.push({ key: "description", header: "Item", align: "left", weight: 60, cells: null });
  if (c.showQuantity) cols.push({ key: "qty", header: "Qty", align: "right", weight: 10, cells: 5 });
  if (!c.hideAmounts) {
    cols.push({ key: "amount", header: "Amount", align: "right", weight: 20, cells: 10 });
  }
  return cols;
}

export function isNarrowMedia(media: LineItemMediaClass): boolean {
  return media === "thermal" || media === "label";
}

/**
 * Resolve the visible line-item columns for a document on a given medium.
 * This is the single entry point every renderer must call.
 */
export function resolveLineItemColumns(
  ctx: LineItemProfileContext | undefined | null,
  media: LineItemMediaClass,
): LineItemColumn[] {
  const c = normaliseLineItemContext(ctx);
  return isNarrowMedia(media) ? narrowProfile(c) : wideProfile(c);
}

/** Convenience: does this profile show any monetary column on this medium? */
export function profileShowsAmounts(
  ctx: LineItemProfileContext | undefined | null,
  media: LineItemMediaClass,
): boolean {
  return resolveLineItemColumns(ctx, media).some(
    (col) => col.key === "amount" || col.key === "unit_price",
  );
}
