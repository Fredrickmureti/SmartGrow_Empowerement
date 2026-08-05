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
import { writeIdentifier } from "@/features/products/identity/writeIdentifier";

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
/**
 * Resolve a packaging level for a product by its base-unit multiplier.
 * Returns null (base unit) when the product has no matching level — the
 * import never invents a level or copies the quantity onto the identifier.
 */
async function resolvePackagingLevel(
  ctx: ImportContext,
  productId: string,
  qty: number,
): Promise<string | null> {
  if (!Number.isFinite(qty) || qty <= 1) return null;
  const { data } = await supabase
    .from("product_packaging")
    .select("id")
    .eq("product_id", productId)
    .eq("business_id", ctx.businessId)
    .eq("qty_in_base_uom", qty)
    .limit(1);
  return (data?.[0] as { id?: string } | undefined)?.id ?? null;
}

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
      // ADR-0110 — the importer is a caller of the identity service, not a
      // second writer. `upsert_product_identifier` enforces primary
      // uniqueness, packaging ownership and cross-product code clashes,
      // and is idempotent for a code already enrolled on this product.
      const failure = await writeIdentifier({
        businessId: ctx.businessId,
        productId,
        code: String(row.barcode).trim(),
        kind: normalizeKind(row.identifier_type),
        isPrimary: toBool(row.is_primary),
        source: "import",
        // Phase D — pack size is owned by the packaging level, so a
        // `packaging_qty` column resolves to that level rather than being
        // copied onto the identifier.
        packagingId: row.packaging_qty != null
          ? await resolvePackagingLevel(ctx, productId, Number(row.packaging_qty))
          : null,
      });
      if (failure) {
        errors.push({ rowIndex: i + 2, data: row, errors: failure });
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
