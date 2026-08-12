/**
 * Product SUPPLIER PRICELIST import config (ADR 0074, ADR 0114).
 *
 * Populates `supplier_item_terms` (vendor cost tiers, lead time) and — when the
 * sheet carries a vendor product code — registers that code as a
 * supplier-scoped product identifier through the canonical write seam, so a
 * receiving clerk can scan the vendor's own carton label. Before ADR 0114 the
 * code was stringified into `notes` as `vendor_sku=…`, where nothing could
 * ever resolve it.
 */
import { FieldDefinition } from "@/lib/importUtils";
import { supabase } from "@/integrations/supabase/client";
import { writeIdentifierResult } from "@/features/products/identity/writeIdentifier";
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
 * ADR-0074 batch handler — writes supplier item terms only. Vendors
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
      // Canonical write seam: the supplier item-terms RPC resolves the party
      // (contact) to its supplier role server-side. ADR-0079.
      const { error } = await (supabase as any).rpc("upsert_supplier_item_terms", {
        p_business_id: ctx.businessId,
        p_vendor_id: vendorId,
        p_product_id: productId,
        p_unit_price: Number(row.cost_price),
        p_currency_code: row.currency ? String(row.currency).trim() : "USD",
        p_min_order_qty:
          row.min_order_qty != null ? Math.max(1, Math.floor(Number(row.min_order_qty))) : 1,
        p_lead_time_days:
          row.lead_time_days != null ? Math.max(0, Math.floor(Number(row.lead_time_days))) : 0,
        p_is_preferred: toBool(row.is_preferred),
        // The vendor product code is an identifier, not a note — it is
        // registered below through the identity write seam.
        p_notes: null,
        p_organization_id: ctx.orgId,
      });
      if (error) {
        if ((error as any).code === "23505") imported++;
        else errors.push({ rowIndex: i + 2, data: row, errors: error.message });
      } else {
        imported++;
      }

      // Supplier-scoped identifier. A failure here must not lose the
      // pricelist row that already landed, so it is reported per row
      // rather than aborting the import.
      const vendorCode = row.vendor_product_code ? String(row.vendor_product_code).trim() : "";
      if (vendorCode) {
        const identity = await writeIdentifierResult({
          businessId: ctx.businessId,
          productId,
          code: vendorCode,
          kind: "supplier",
          supplierId: vendorId,
          source: "import",
        });
        if (identity.status !== "ok") {
          errors.push({
            rowIndex: i + 2,
            data: row,
            errors: `Vendor code "${vendorCode}" not registered — ${identity.message}`,
          });
        }
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
