/**
 * Product SUPPLIER PRICELIST import config (ADR 0074).
 *
 * Populates `vendor_pricelists` (vendor cost tiers, lead time).
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

export const PRODUCT_SUPPLIER_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "sku", label: "SKU", required: true, type: "text", aliases: ["product_code", "code", "SKU"] },
  { key: "vendor", label: "Vendor / Supplier", required: true, type: "text", aliases: ["supplier", "vendor_name", "vendor_code"] },
  { key: "vendor_product_code", label: "Vendor Product Code", required: false, type: "text", aliases: ["supplier_sku", "vendor_sku"] },
  { key: "cost_price", label: "Cost Price", required: true, type: "number", aliases: ["cost", "purchase_price"] },
  { key: "currency", label: "Currency", required: false, type: "text", aliases: ["ccy"] },
  { key: "min_order_qty", label: "Minimum Order Qty", required: false, type: "number", aliases: ["moq", "min_order"] },
  { key: "lead_time_days", label: "Lead Time (days)", required: false, type: "number", aliases: ["lead_time", "days"] },
  { key: "is_preferred", label: "Preferred Vendor", required: false, type: "text", aliases: ["preferred", "primary"] },
];

function toBool(v: unknown): boolean {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

/**
 * ADR-0074 batch handler — writes to `vendor_pricelists` only. Vendors
 * must already exist as supplier contacts (contacts.supplier_rank > 0);
 * unknown vendors surface in the errors array instead of being auto-created
 * (business-master data hygiene).
 *
 * Idempotency: unique `(organization_id, vendor_id, product_id)`.
 */
export function createProductSupplierBatchMigrationHandler(ctx: ImportContext) {
  return async (rows: Record<string, any>[]): Promise<BatchResult> => {
    const errors: RowError[] = [];
    const resolved = await resolveProductIds(ctx, rows);

    const vendorKeys = Array.from(
      new Set(rows.map((r) => (r.vendor ? String(r.vendor).trim() : "")).filter(Boolean)),
    );
    const vendorByName = new Map<string, string>();
    if (vendorKeys.length) {
      const { data } = await supabase
        .from("contacts")
        .select("id, name")
        .eq("organization_id", ctx.orgId)
        .eq("business_id", ctx.businessId)
        .gt("supplier_rank", 0)
        .in("name", vendorKeys);
      for (const c of (data ?? []) as { id: string; name: string }[]) vendorByName.set(c.name, c.id);
    }

    let imported = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const productId = resolved.get(i);
      if (!productId) {
        errors.push({ rowIndex: i + 2, data: row, errors: `Unknown product (sku=${row.sku ?? ""})` });
        continue;
      }
      const vendorKey = row.vendor ? String(row.vendor).trim() : "";
      const vendorId = vendorByName.get(vendorKey);
      if (!vendorId) {
        errors.push({ rowIndex: i + 2, data: row, errors: `Unknown vendor "${vendorKey}" (must exist as supplier contact)` });
        continue;
      }
      if (row.cost_price == null || isNaN(Number(row.cost_price))) {
        errors.push({ rowIndex: i + 2, data: row, errors: "Missing/invalid cost_price" });
        continue;
      }
      const { error } = await supabase.from("vendor_pricelists").insert({
        organization_id: ctx.orgId,
        business_id: ctx.businessId,
        vendor_id: vendorId,
        product_id: productId,
        unit_price: Number(row.cost_price),
        currency: row.currency ? String(row.currency).trim() : "USD",
        min_order_qty: row.min_order_qty != null ? Math.max(1, Math.floor(Number(row.min_order_qty))) : 1,
        lead_time_days: row.lead_time_days != null ? Math.max(0, Math.floor(Number(row.lead_time_days))) : 0,
        is_preferred: toBool(row.is_preferred),
        is_active: true,
        notes: row.vendor_product_code ? `vendor_sku=${row.vendor_product_code}` : null,
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
      orgId: ctx.orgId, businessId: ctx.businessId, kind: "supplier",
      batchId: newBatchId(), result, branchId: ctx.branchId, warehouseId: ctx.warehouseId,
    });
    return result;
  };
}
