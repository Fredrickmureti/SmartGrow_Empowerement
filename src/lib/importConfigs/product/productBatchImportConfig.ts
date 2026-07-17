/**
 * Product BATCH / LOT import config (ADR 0074).
 *
 * Populates `stock_lots` (lot_number, mfg/expiry). Requires SKU or barcode
 * to resolve the product; warehouse/quantity live in the warehouse-stock config.
 */
import { FieldDefinition } from "@/lib/importUtils";
import { supabase } from "@/integrations/supabase/client";
import {
  type BatchResult,
  type ImportContext,
  type RowError,
  resolveProductIds,
} from "./_resolveProduct";
import { emitProductImportCompleted, newBatchId } from "./_emitImportEvent";

export const PRODUCT_BATCH_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "sku", label: "SKU", required: false, type: "text", aliases: ["product_code", "code", "SKU"] },
  { key: "barcode", label: "Barcode / GTIN", required: false, type: "text", aliases: ["gtin", "ean", "upc"] },
  { key: "lot_number", label: "Lot / Batch Number", required: true, type: "text", aliases: ["batch", "batch_no", "lot", "Lot No"] },
  { key: "manufacture_date", label: "Manufacture Date", required: false, type: "date", aliases: ["mfg_date", "mfg", "produced_on"] },
  { key: "expiry_date", label: "Expiry Date", required: false, type: "date", aliases: ["expiry", "expires", "best_before", "Expiry"] },
  { key: "supplier_lot_number", label: "Supplier Lot Number", required: false, type: "text", aliases: ["vendor_lot", "supplier_batch"] },
];

function toDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * ADR-0074 batch handler — writes to `stock_lots` only.
 * Idempotency: unique `(business_id, product_id, lot_number, serial_number)`.
 */
export function createProductBatchBatchMigrationHandler(ctx: ImportContext) {
  return async (rows: Record<string, any>[]): Promise<BatchResult> => {
    const errors: RowError[] = [];
    const resolved = await resolveProductIds(ctx, rows);
    let imported = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const productId = resolved.get(i);
      if (!productId) {
        errors.push({ rowIndex: i + 2, data: row, errors: `Unknown product (sku=${row.sku ?? ""}, barcode=${row.barcode ?? ""})` });
        continue;
      }
      if (!row.lot_number) {
        errors.push({ rowIndex: i + 2, data: row, errors: "Missing lot_number" });
        continue;
      }
      const notes = row.supplier_lot_number ? `supplier_lot=${row.supplier_lot_number}` : null;
      const { error } = await supabase.from("stock_lots").insert({
        organization_id: ctx.orgId,
        business_id: ctx.businessId,
        product_id: productId,
        lot_number: String(row.lot_number).trim(),
        manufacture_date: toDate(row.manufacture_date),
        expiry_date: toDate(row.expiry_date),
        notes,
        is_active: true,
      } as any);
      if (error) {
        if ((error as any).code === "23505") imported++;
        else errors.push({ rowIndex: i + 2, data: row, errors: error.message });
      } else {
        imported++;
      }
    }
    const result: BatchResult = { total: rows.length, imported, skipped: errors.length, errors };
    await emitProductImportCompleted({
      orgId: ctx.orgId, businessId: ctx.businessId, kind: "batch",
      batchId: newBatchId(), result, branchId: ctx.branchId, warehouseId: ctx.warehouseId,
    });
    return result;
  };
}
