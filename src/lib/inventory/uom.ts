/**
 * Multi-Unit Inventory — single conversion + presentation layer.
 *
 * Inventory is always stored in BASE units. Transactional documents
 * (POS, Invoices, Sales Orders, Estimates, POs, GRNs, Delivery Notes,
 * Bills, Credit Notes, Returns) ALSO remember the unit the user actually
 * transacted in via three columns:
 *
 *   packaging_id      — FK to product_packaging
 *   display_uom_id    — FK to units_of_measure (defaults to product.base_uom_id)
 *   display_quantity  — count of `packaging_id` units the user entered
 *   uom_snapshot      — frozen human label ("Box × 10 ea") — survives renames
 *
 * The base quantity that hits the ledger is always
 *   quantity_base = display_quantity * qty_in_base_uom
 *
 * Every renderer, exporter, and report MUST go through the helpers here so
 * pack vs base presentation stays consistent across the whole platform.
 */

export interface PackagingRef {
  /** Pack name as configured on product_packaging (e.g. "Box", "Strip"). */
  name?: string | null;
  /** Multiplier from this pack to the product's base unit. */
  qty_in_base_uom?: number | null;
}

export interface LineWithProvenance {
  /** FK to product_packaging — presence alone signals "this line uses a pack". */
  packaging_id?: string | null;
  /** Base-unit quantity stored on the ledger row. */
  quantity?: number | null;
  /** Display-unit quantity entered by the user. Null = no pack chosen. */
  display_quantity?: number | null;
  /** Frozen label e.g. "Box × 10 ea". Optional. */
  uom_snapshot?: string | null;
  /** Resolved packaging row (joined). Optional. */
  packaging?: PackagingRef | null;
  /** Convenience: short display label when the packaging row was not joined. */
  packaging_label?: string | null;
}

export interface BaseUomRef {
  /** Short symbol/code ("ea", "tab"). */
  code?: string | null;
  /** Long name ("Each", "Tablet"). */
  name?: string | null;
}

/** Convert a display quantity into base units. Falls back to display when packaging is missing. */
export function toBase(displayQty: number, packaging?: PackagingRef | null): number {
  if (!Number.isFinite(displayQty)) return 0;
  const f = Number(packaging?.qty_in_base_uom);
  if (!Number.isFinite(f) || f <= 0) return displayQty;
  return displayQty * f;
}

/** Convert a base quantity back to display units for a given packaging. */
export function fromBase(baseQty: number, packaging?: PackagingRef | null): number {
  if (!Number.isFinite(baseQty)) return 0;
  const f = Number(packaging?.qty_in_base_uom);
  if (!Number.isFinite(f) || f <= 0) return baseQty;
  return baseQty / f;
}

/**
 * Short label for the base unit of a *transaction line*, where a missing
 * reference legitimately means "counted piece" ("ea").
 *
 * Do NOT use this for a product master surface — a product whose
 * `base_uom_id` is unset is a configuration defect, and calling it "ea"
 * silently mislabels sugar as a countable item. Use
 * {@link productBaseLabel} there.
 */
export function baseUomLabel(uom?: BaseUomRef | null): string {
  return (uom?.code || uom?.name || "ea").trim() || "ea";
}

/**
 * PostgREST embed that every product query feeding a quantity display MUST
 * include. `products` has NO `unit_of_measure` column — the canonical base
 * unit is `base_uom_id → units_of_measure`. Selecting a flat
 * `unit_of_measure` yields `undefined`, which is how "383 ea" reached the
 * inventory grid for a product stocked in kilograms.
 */
export const PRODUCT_BASE_UOM_SELECT = "base_uom:units_of_measure!base_uom_id(code, name)";

/** Rendered in place of a unit when the product has no base UoM configured. */
export const UOM_UNSET_LABEL = "(no UoM)";

export interface ProductUomRef {
  base_uom?: BaseUomRef | null;
}

/**
 * Canonical base-unit label for a PRODUCT. Returns `null` when the product
 * has no base UoM configured, so the caller can surface a data-integrity
 * state instead of inventing a unit.
 */
export function productBaseLabel(product?: ProductUomRef | null): string | null {
  const label = (product?.base_uom?.code || product?.base_uom?.name || "").trim();
  return label || null;
}

/**
 * Display-safe variant: the product's real base unit, or a visible
 * "(no UoM)" marker. Never "ea" by default.
 */
export function productBaseLabelOrUnset(product?: ProductUomRef | null): string {
  return productBaseLabel(product) ?? UOM_UNSET_LABEL;
}


/** Snapshot string written at transaction time so renames don't drift receipts. */
export function buildUomSnapshot(
  packagingName: string | null | undefined,
  qtyInBaseUom: number | null | undefined,
  baseLabel: string,
): string | null {
  if (!packagingName) return null;
  const f = Number(qtyInBaseUom);
  if (!Number.isFinite(f) || f <= 1) return packagingName;
  return `${packagingName} × ${f} ${baseLabel}`;
}

export interface FormattedLineQty {
  /** Primary user-facing label, e.g. "1 Box" or "10 ea". */
  primary: string;
  /** Optional secondary breakdown, e.g. "(10 ea)". Null when nothing to add. */
  secondary: string | null;
  /** Numeric base-unit quantity (for sorting / aggregation). */
  baseQuantity: number;
  /** Numeric display quantity (== baseQuantity when no packaging). */
  displayQuantity: number;
  /** Short pack label, or the base UoM label when no pack is in play. */
  unitLabel: string;
}

export interface FormatLineQtyOptions {
  /** Default base-unit label when nothing else resolves it. */
  baseLabel?: string;
  /**
   * Render the secondary base-unit breakdown when a pack is in play.
   * Default true — set false for ultra-compact thermal layouts.
   */
  showBaseBreakdown?: boolean;
}

/**
 * Format a transaction-line quantity using its persisted pack provenance.
 *
 * - "1 Box (10 ea)"  — when packaging is present and base differs from display.
 * - "1 Box"           — when packaging is present and the secondary breakdown is suppressed.
 * - "10 ea"           — when no packaging is present.
 */
export function formatLineQty(
  line: LineWithProvenance,
  opts: FormatLineQtyOptions = {},
): FormattedLineQty {
  const baseLabel = (opts.baseLabel || "ea").trim() || "ea";
  const showBreakdown = opts.showBaseBreakdown !== false;

  const base = Number(line.quantity ?? 0);
  const display = Number(line.display_quantity ?? NaN);
  const packLabel =
    line.packaging?.name?.trim() ||
    line.packaging_label?.trim() ||
    (line.uom_snapshot ? line.uom_snapshot.split("×")[0]?.trim() : "") ||
    "";

  if (line.packaging_id !== undefined || line.packaging || packLabel) {
    // Pack provenance present.
    const dq = Number.isFinite(display) && display > 0
      ? display
      : fromBase(base, line.packaging ?? undefined);
    const dqStr = formatNumber(dq);
    const primary = packLabel ? `${dqStr} ${packLabel}` : `${dqStr} ${baseLabel}`;
    const factor = Number(line.packaging?.qty_in_base_uom);
    const hasFactor = Number.isFinite(factor) && factor > 1;
    const secondary =
      showBreakdown && hasFactor
        ? `${formatNumber(base)} ${baseLabel}`
        : null;
    return {
      primary,
      secondary,
      baseQuantity: base,
      displayQuantity: dq,
      unitLabel: packLabel || baseLabel,
    };
  }

  return {
    primary: `${formatNumber(base)} ${baseLabel}`,
    secondary: null,
    baseQuantity: base,
    displayQuantity: base,
    unitLabel: baseLabel,
  };
}

/**
 * Convenience: a single string like "1 Box (10 ea)" — what most callers want.
 */
export function formatLineQtyString(
  line: LineWithProvenance,
  opts: FormatLineQtyOptions = {},
): string {
  const f = formatLineQty(line, opts);
  return f.secondary ? `${f.primary} (${f.secondary})` : f.primary;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // Drop trailing zeros; keep up to 3 decimals (matches formatQty.ts).
  return String(Number(n.toFixed(3)));
}
