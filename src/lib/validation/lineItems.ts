/**
 * Shared submit-time validation for document line items
 * (invoices, estimates, sales orders, proformas, delivery notes,
 * sales returns, credit notes).
 *
 * Goals:
 *  - Block submission when a line has quantity <= 0 (the user-reported bug).
 *  - Surface row-targeted errors instead of silently filtering bad rows.
 *  - Keep "no zero-line invoice" rule intact.
 */

export interface LineRowLike {
  description?: string | null;
  product_id?: string | null;
  quantity?: number | null;
  quantity_ordered?: number | null;
  quantity_delivered?: number | null;
  unit_price?: number | null;
  max_quantity?: number | null;
}

export interface ValidateLineItemsOptions {
  /** Allow lines whose unit_price is 0 (default: true — free items are valid). */
  allowZeroPrice?: boolean;
  /** Which field holds the quantity for this doc type. */
  quantityKey?: "quantity" | "quantity_ordered";
  /** When true, an entirely empty doc is allowed (used by Estimate edit). */
  allowEmptyDoc?: boolean;
  /** When true, validate quantity does not exceed `max_quantity` (sales return). */
  enforceMaxQuantity?: boolean;
  /** Doc label for the toast title, e.g. "invoice", "estimate". */
  docLabel?: string;
}

export type ValidateLineItemsResult<T extends LineRowLike> =
  | { ok: true; valid: T[]; error?: undefined }
  | { ok: false; error: string; valid?: undefined };

function isRowTouched(row: LineRowLike, qtyKey: "quantity" | "quantity_ordered"): boolean {
  const desc = (row.description ?? "").toString().trim();
  const hasDesc = desc.length > 0;
  const hasProduct = !!row.product_id;
  const qty = Number(row[qtyKey]);
  const hasQty = Number.isFinite(qty) && qty !== 0 && qty !== 1; // default 1 doesn't count as "touched"
  const price = Number(row.unit_price);
  const hasPrice = Number.isFinite(price) && price > 0;
  return hasDesc || hasProduct || hasQty || hasPrice;
}

export function validateLineItems<T extends LineRowLike>(
  rows: T[],
  options: ValidateLineItemsOptions = {},
): ValidateLineItemsResult<T> {
  const {
    allowZeroPrice = true,
    quantityKey = "quantity",
    allowEmptyDoc = false,
    enforceMaxQuantity = false,
  } = options;

  const valid: T[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lineNo = i + 1;

    if (!isRowTouched(row, quantityKey)) {
      // Untouched empty row — silently skip, not an error.
      continue;
    }

    const desc = (row.description ?? "").toString().trim();
    if (!desc && !row.product_id) {
      return {
        ok: false,
        error: `Line ${lineNo}: please pick a product or enter a description.`,
      };
    }

    const qty = Number(row[quantityKey]);
    if (!Number.isFinite(qty) || qty <= 0) {
      return {
        ok: false,
        error: `Line ${lineNo}: quantity must be greater than 0.`,
      };
    }

    if (enforceMaxQuantity && row.max_quantity != null) {
      const max = Number(row.max_quantity);
      if (Number.isFinite(max) && qty > max) {
        return {
          ok: false,
          error: `Line ${lineNo}: quantity cannot exceed ${max}.`,
        };
      }
    }

    const price = row.unit_price == null ? 0 : Number(row.unit_price);
    if (!Number.isFinite(price) || price < 0) {
      return {
        ok: false,
        error: `Line ${lineNo}: unit price must be 0 or greater.`,
      };
    }
    if (!allowZeroPrice && price <= 0) {
      return {
        ok: false,
        error: `Line ${lineNo}: unit price must be greater than 0.`,
      };
    }

    valid.push(row);
  }

  if (valid.length === 0 && !allowEmptyDoc) {
    return {
      ok: false,
      error: "Please add at least one line item with a quantity greater than 0.",
    };
  }

  return { ok: true, valid };
}
