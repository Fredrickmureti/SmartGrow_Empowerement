/**
 * labelBarcode — ADR-0089. Enterprise barcode identity policy for
 * printable labels.
 *
 * The one rule this module exists to enforce: an internal database
 * identifier (UUID / bigint / row primary key) must NEVER be encoded as
 * a scannable barcode. Scanners on the shop floor read that value back
 * into the ERP and expect it to identify a product; a UUID does not.
 * Prior to this module, `src/pages/Products.tsx` computed
 * `code = product.barcode || product.sku || product.id`, so a product
 * with no barcode and no SKU printed a UUID under the bars — the exact
 * "characters that look like a database ID" the operator reported.
 *
 * Contract:
 *   resolveLabelBarcode(product) → { code, hri, skuDisplay } | null
 *
 * Priority for `code`:
 *   1. product.barcode  (any non-empty printable string — assumed to be
 *      a validated GTIN/EAN/UPC/Code128 payload set at enrollment)
 *   2. product.sku      (non-empty, printable ASCII)
 *   3. null             — REFUSE. The UI must not print.
 *
 * `hri` (human-readable interpretation printed by the barcode symbology
 * itself) is always 'N'; the human line under the bars is authored
 * separately in the template via `{{sku_display}}` so it can carry
 * currency, size, batch, etc. without polluting the encoded payload.
 *
 * `skuDisplay` is the text that should appear under the barcode: the
 * SKU when set, otherwise a blank string (never the UUID).
 */

export type PrintableProduct = {
  id?: string | null;
  sku?: string | null;
  barcode?: string | null;
  name?: string | null;
};

export interface ResolvedLabelBarcode {
  code: string;
  hri: 'Y' | 'N';
  skuDisplay: string;
}

const PRINTABLE = /^[\x20-\x7E]+$/;

function normalise(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (!PRINTABLE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Returns a printable barcode payload, or null when the product has no
 * legitimate identifier. Callers MUST NOT fall back to `product.id` on
 * their own — that is the failure mode this module prevents.
 */
/**
 * Phase C5 — packaging-level context for a label.
 *
 * A case label must encode the CASE identifier. Printing the each-level
 * barcode on a case is the same class of error as printing a UUID: the
 * scanner reads it back and the ERP books 1 unit instead of 12. When a
 * level is requested and that level has no enrolled identifier, this
 * module REFUSES — it never falls back to another level's code, to the
 * SKU, or to an internal id.
 */
export interface LabelPackagingLevel {
  /** Packaging row id (audit / idempotency only, never encoded). */
  packagingId?: string | null;
  /** Level display name, e.g. "Case of 12". */
  name?: string | null;
  /** Identifier enrolled against THIS level. */
  code?: string | null;
  /** Base units contained in one of this level. */
  qtyInBaseUom?: number | null;
}

export function resolveLabelBarcode(
  product: PrintableProduct,
  level?: LabelPackagingLevel | null,
): ResolvedLabelBarcode | null {
  const sku = normalise(product?.sku);

  // Level-specific label: only that level's own identifier is acceptable.
  if (level && (level.packagingId || level.name || level.code)) {
    const levelCode = normalise(level.code);
    if (!levelCode) return null;
    return { code: levelCode, hri: 'N', skuDisplay: sku ?? '' };
  }

  const barcode = normalise(product?.barcode);
  const code = barcode ?? sku;
  if (!code) return null;
  return { code, hri: 'N', skuDisplay: sku ?? '' };
}

/** Static UI copy for the refusal toast — kept here so every caller uses
 *  the same wording and enrollment CTA. */
export const LABEL_BARCODE_REFUSAL = {
  title: 'No barcode or SKU assigned',
  description:
    'This product has no barcode and no SKU, so there is nothing scannable to print. ' +
    'Assign a SKU in Product → Identifiers, or enroll a barcode from the item detail.',
} as const;

/** Refusal copy for a packaging-level label whose level has no identifier. */
export const LABEL_LEVEL_BARCODE_REFUSAL = {
  title: 'This packaging level has no barcode',
  description:
    'The selected packaging level (case / inner / pallet) has no enrolled identifier, and a ' +
    'level label must never encode another level\'s code. Enrol a barcode for this level in ' +
    'Inventory → Products → Enrol barcodes, then print again.',
} as const;
