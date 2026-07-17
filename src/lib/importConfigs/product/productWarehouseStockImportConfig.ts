/**
 * Product WAREHOUSE STOCK / opening-balance import config (ADR 0074).
 *
 * Creates initial `stock_quants` (post-Phase-5) rows via a controlled
 * opening-balance adjustment. Does NOT modify master fields.
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

export const PRODUCT_WAREHOUSE_STOCK_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "sku", label: "SKU", required: true, type: "text", aliases: ["product_code", "code", "SKU"] },
  { key: "warehouse", label: "Warehouse", required: true, type: "text", aliases: ["location", "warehouse_code", "site"] },
  { key: "lot_number", label: "Lot / Batch Number", required: false, type: "text", aliases: ["batch", "lot"] },
  { key: "quantity", label: "On-Hand Quantity", required: true, type: "number", aliases: ["qty", "stock", "on_hand", "Opening Stock", "Quantity on Hand"] },
  { key: "reorder_level", label: "Reorder Level", required: false, type: "number", aliases: ["min stock", "Reorder Level", "Reorder Point"] },
  { key: "reorder_quantity", label: "Reorder Quantity", required: false, type: "number", aliases: ["reorder qty", "Order Quantity"] },
];

/**
 * ADR-0074 batch handler — opening-balance stock via `stock_adjustments`.
 *
 * CRITICAL: this handler MUST NOT write to `warehouse_stock` directly.
 * Opening balances are posted as an `adjustment_type = 'opening_balance'`
 * stock_adjustments header + one item per row so `stock_quants` and the
 * ledger stay authoritative (see Steps 2/3 in .lovable/plan.md).
 */
export function createProductWarehouseStockBatchMigrationHandler(ctx: ImportContext) {
  return async (rows: Record<string, any>[]): Promise<BatchResult> => {
    const errors: RowError[] = [];
    if (!ctx.branchId) {
      return {
        total: rows.length,
        imported: 0,
        skipped: rows.length,
        errors: rows.map((data, i) => ({ rowIndex: i + 2, data, errors: "branchId required for warehouse-stock import" })),
      };
    }

    // Resolve warehouses by code or name up-front.
    const whKeys = Array.from(
      new Set(rows.map((r) => (r.warehouse ? String(r.warehouse).trim() : "")).filter(Boolean)),
    );
    const whByKey = new Map<string, string>();
    if (whKeys.length) {
      const { data } = await supabase
        .from("warehouses")
        .select("id, name, code")
        .eq("organization_id", ctx.orgId)
        .eq("business_id", ctx.businessId);
      for (const w of (data ?? []) as { id: string; name: string; code: string | null }[]) {
        if (w.code) whByKey.set(w.code, w.id);
        if (w.name) whByKey.set(w.name, w.id);
      }
    }

    const resolved = await resolveProductIds(ctx, rows);

    // Group by warehouse — one adjustment header per warehouse.
    const groups = new Map<string, { productId: string; row: Record<string, any>; index: number }[]>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const productId = resolved.get(i);
      if (!productId) {
        errors.push({ rowIndex: i + 2, data: row, errors: `Unknown product (sku=${row.sku ?? ""})` });
        continue;
      }
      const whKey = row.warehouse ? String(row.warehouse).trim() : "";
      const warehouseId = whByKey.get(whKey);
      if (!warehouseId) {
        errors.push({ rowIndex: i + 2, data: row, errors: `Unknown warehouse "${whKey}"` });
        continue;
      }
      if (row.quantity == null || isNaN(Number(row.quantity))) {
        errors.push({ rowIndex: i + 2, data: row, errors: "Missing/invalid quantity" });
        continue;
      }
      if (!groups.has(warehouseId)) groups.set(warehouseId, []);
      groups.get(warehouseId)!.push({ productId, row, index: i });
    }

    let imported = 0;
    const stamp = new Date().toISOString();
    for (const [warehouseId, items] of groups.entries()) {
      const { data: adj, error: hdrErr } = await supabase
        .from("stock_adjustments")
        .insert({
          organization_id: ctx.orgId,
          business_id: ctx.businessId,
          branch_id: ctx.branchId,
          warehouse_id: warehouseId,
          adjustment_number: `OB-${stamp}-${warehouseId.slice(0, 8)}`,
          adjustment_date: stamp,
          adjustment_type: "opening_balance",
          reason: "Opening balance (CSV import)",
          status: "posted",
          allow_negative: false,
        } as any)
        .select("id")
        .single();
      if (hdrErr || !adj) {
        for (const it of items) {
          errors.push({ rowIndex: it.index + 2, data: it.row, errors: `Header insert failed: ${hdrErr?.message ?? "unknown"}` });
        }
        continue;
      }
      const itemsPayload = items.map((it) => ({
        adjustment_id: (adj as any).id,
        product_id: it.productId,
        warehouse_id: warehouseId,
        branch_id: ctx.branchId!,
        quantity_before: 0,
        quantity_adjustment: Number(it.row.quantity),
        quantity_after: Number(it.row.quantity),
        lot_number: it.row.lot_number ? String(it.row.lot_number).trim() : null,
      }));
      const { error: itemErr } = await supabase.from("stock_adjustment_items").insert(itemsPayload as any);
      if (itemErr) {
        for (const it of items) {
          errors.push({ rowIndex: it.index + 2, data: it.row, errors: `Item insert failed: ${itemErr.message}` });
        }
      } else {
        imported += items.length;
      }
    }

    const result: BatchResult = { total: rows.length, imported, skipped: errors.length, errors };
    await emitProductImportCompleted({
      orgId: ctx.orgId, businessId: ctx.businessId, kind: "warehouse_stock",
      batchId: newBatchId(), result, branchId: ctx.branchId, warehouseId: ctx.warehouseId,
    });
    return result;
  };
}
