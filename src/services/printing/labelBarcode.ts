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
export function resolveLabelBarcode(product: PrintableProduct): ResolvedLabelBarcode | null {
  const barcode = normalise(product?.barcode);
  const sku = normalise(product?.sku);
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
