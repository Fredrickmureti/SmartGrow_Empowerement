/**
 * Stage X2 — customer display renderer.
 *
 * Pushes a "thank you / change due" frame to the secondary screen via
 * the hardware proxy. No-op gracefully when no customer display is
 * registered (the proxy resolves it itself).
 */
import type { ReceiptDocumentModel } from "../ReceiptDocumentModel";

export interface UpdateDisplayFn {
  (data: unknown): Promise<{ success: boolean; error?: string }>;
}

export async function showSuccessOnCustomerDisplay(
  model: ReceiptDocumentModel,
  updateDisplay: UpdateDisplayFn,
): Promise<void> {
  try {
    await updateDisplay({
      status: "complete",
      total: model.totals.total_amount,
      subtotal: model.totals.subtotal,
      tax: model.totals.tax_amount,
      discount: model.totals.discount_amount,
      items: model.items.map((i) => ({
        id: i.sku ?? i.product_name,
        name: i.product_name,
        quantity: i.quantity,
        display_quantity: i.display_quantity ?? null,
        packaging_label: i.packaging_label ?? null,
        base_uom_label: i.base_uom_label ?? null,
        price: i.unit_price,
        total: i.line_total,
      })),
      customerName: model.meta.customer_name ?? undefined,
      message:
        model.totals.change_due > 0
          ? `THANK YOU — Change ${model.totals.change_due.toFixed(2)}`
          : "THANK YOU",
    });
  } catch {
    // Customer display is best-effort — never block the cashier flow.
  }
}