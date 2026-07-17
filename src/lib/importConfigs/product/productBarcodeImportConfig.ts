/**
 * Product BARCODE / GTIN import config (ADR 0074).
 *
 * Populates `product_identifiers` (GTIN-8/12/13/14, ISBN, custom).
 * Must NOT accept master-catalog fields — resolve product by SKU only.
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

export const PRODUCT_BARCODE_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "sku", label: "SKU", required: true, type: "text", aliases: ["code", "item_code", "product_code", "SKU", "Product Code"] },
  { key: "barcode", label: "Barcode / GTIN", required: true, type: "text", aliases: ["gtin", "ean", "upc", "ean13", "ean_13", "Barcode", "GTIN", "EAN", "UPC"] },
  { key: "identifier_type", label: "Identifier Type", required: false, type: "select", aliases: ["type", "kind"], options: ["gtin8", "gtin12", "gtin13", "gtin14", "isbn", "custom"], allowFallback: true, fallbackValue: "gtin13" },
  { key: "is_primary", label: "Is Primary", required: false, type: "text", aliases: ["primary", "default"] },
  { key: "packaging_qty", label: "Packaging Qty", required: false, type: "number", aliases: ["case size", "pack qty", "units per pack"] },
];

function toBool(v: unknown): boolean {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function normalizeKind(raw: unknown): string {
  const v = raw ? String(raw).toLowerCase().trim() : "";
  // product_identifier_kind enum: gtin, sku, pack, supplier, internal, plu, alias
  if (v.startsWith("gtin") || v === "ean" || v === "upc" || v === "isbn") return "gtin";
  if (v === "sku") return "sku";
  if (v === "pack" || v === "carton" || v === "pallet") return "pack";
  if (v === "supplier" || v === "vendor") return "supplier";
  if (v === "internal") return "internal";
  if (v === "plu") return "plu";
  if (v === "alias") return "alias";
  return "gtin";
}

/**
 * ADR-0074 batch handler — writes to `product_identifiers` only.
 * Product resolution: SKU (required per field def) with barcode fallback.
 * Idempotency: relies on unique `(business_id, code_norm, kind)`.
 */
export function createProductBarcodeBatchMigrationHandler(ctx: ImportContext) {
  return async (rows: Record<string, any>[]): Promise<BatchResult> => {
    const errors: RowError[] = [];
    const resolved = await resolveProductIds(ctx, rows);
    let imported = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const productId = resolved.get(i);
      if (!productId) {
        errors.push({ rowIndex: i + 2, data: row, errors: `Unknown product (sku=${row.sku ?? ""})` });
        continue;
      }
      if (!row.barcode) {
        errors.push({ rowIndex: i + 2, data: row, errors: "Missing barcode" });
        continue;
      }
      const { error } = await supabase.from("product_identifiers").insert({
        organization_id: ctx.orgId,
        business_id: ctx.businessId,
        product_id: productId,
        code: String(row.barcode).trim(),
        kind: normalizeKind(row.identifier_type) as any,
        is_primary: toBool(row.is_primary),
        pack_quantity: row.packaging_qty != null ? Number(row.packaging_qty) : null,
      } as any);
      if (error) {
        // 23505 = unique violation → treat as already imported (idempotent).
        if ((error as any).code === "23505") {
          imported++;
        } else {
          errors.push({ rowIndex: i + 2, data: row, errors: error.message });
        }
      } else {
        imported++;
      }
    }
    const result: BatchResult = { total: rows.length, imported, skipped: errors.length, errors };
    await emitProductImportCompleted({
      orgId: ctx.orgId, businessId: ctx.businessId, kind: "barcode",
      batchId: newBatchId(), result, branchId: ctx.branchId, warehouseId: ctx.warehouseId,
    });
    return result;
  };
}
