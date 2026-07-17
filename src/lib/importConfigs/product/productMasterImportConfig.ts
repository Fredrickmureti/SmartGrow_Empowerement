/**
 * Product MASTER import config.
 *
 * ADR 0074 — Product imports are split by concern. This file holds ONLY the
 * canonical product master fields (identity + pricing + classification).
 * Inventory, barcode/GTIN, batch/lot, price-list, and supplier-pricelist
 * data live in sibling configs and MUST NOT be merged back here.
 */
import { FieldDefinition } from "@/lib/importUtils";
import { supabase } from "@/integrations/supabase/client";

export const PRODUCT_MASTER_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "name", label: "Name", required: true, type: "text", aliases: ["product name", "item_name", "product", "item", "title", "Product Name", "description"] },
  { key: "description", label: "Description", required: false, type: "text", aliases: ["desc", "details", "Notes", "notes"] },
  { key: "type", label: "Type", required: false, type: "select", aliases: ["item type", "Type", "product type", "Product Type", "Item Type", "product_type"], options: ["product", "service"], allowFallback: true, fallbackValue: "product" },
  { key: "sku", label: "SKU", required: false, type: "text", aliases: ["code", "item_code", "product_code", "part_number", "SKU", "Product Code", "Part Number"] },
  { key: "unit_price", label: "Unit Price", required: false, type: "number", aliases: ["price", "selling_price", "sales_price", "sale_price", "Selling Price", "Unit Price", "Rate", "Sales Price"] },
  { key: "cost_price", label: "Cost Price", required: false, type: "number", aliases: ["cost", "purchase_price", "unit_cost", "Cost Price", "Purchase Price", "Cost"] },
  { key: "tax_rate", label: "Tax Rate", required: false, type: "number", aliases: ["tax", "vat", "tax %", "Tax Rate", "Tax (16%)", "VAT Rate"] },
  { key: "category", label: "Category", required: false, type: "category", aliases: ["product category", "group", "class", "Category", "Product Category", "Item Category"] },
  { key: "unit", label: "Unit of Measure", required: false, type: "text", aliases: ["unit", "uom", "Unit", "UOM", "Unit of Measure", "Selling Unit"] },
];

export function normalizeProductType(raw: string | undefined): "product" | "service" {
  if (!raw) return "product";
  const v = raw.toLowerCase().trim();
  if (v === "service" || v === "services") return "service";
  return "product";
}

export function createProductMasterMigrationHandler(orgId: string) {
  return async (row: Record<string, any>) => {
    const productType = normalizeProductType(row.type || row.product_type);
    const { error } = await supabase.from("products").insert({
      organization_id: orgId,
      name: row.name,
      sku: row.sku || null,
      product_type: productType === "service" ? "service" : "goods",
      sale_price: row.unit_price || row.sale_price || 0,
      cost_price: row.cost_price || 0,
      description: row.description || null,
      unit: row.unit || null,
    } as any);
    if (error) throw error;
  };
}

export function createProductMasterBatchMigrationHandler(orgId: string) {
  return async (rows: Record<string, any>[]) => {
    const errors: { rowIndex: number; data: Record<string, any>; errors: string }[] = [];
    const insertRows = rows.map((row) => {
      const productType = normalizeProductType(row.type || row.product_type);
      return {
        organization_id: orgId,
        name: row.name,
        sku: row.sku || null,
        product_type: productType === "service" ? "service" : "goods" as const,
        sale_price: row.unit_price || row.sale_price || 0,
        cost_price: row.cost_price || 0,
        description: row.description || null,
        unit: row.unit || null,
      };
    });

    const CHUNK = 200;
    let imported = 0;
    for (let i = 0; i < insertRows.length; i += CHUNK) {
      const chunk = insertRows.slice(i, i + CHUNK);
      const { error } = await supabase.from("products").insert(chunk as any);
      if (error) {
        for (let j = 0; j < chunk.length; j++) {
          const { error: rowErr } = await supabase.from("products").insert(chunk[j] as any);
          if (rowErr) {
            errors.push({ rowIndex: i + j + 2, data: rows[i + j], errors: rowErr.message });
          } else {
            imported++;
          }
        }
      } else {
        imported += chunk.length;
      }
    }

    return { total: rows.length, imported, skipped: errors.length, errors };
  };
}
