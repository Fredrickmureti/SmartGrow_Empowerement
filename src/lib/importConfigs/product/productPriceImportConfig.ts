/**
 * Product PRICE-LIST import config (ADR 0074).
 *
 * Populates `price_list_items` under a named `price_lists` row.
 */
import { FieldDefinition } from "@/lib/importUtils";
import { supabase } from "@/integrations/supabase/client";
import {
  type BatchResult,
  type ImportContext,
  type RowError,
  resolveProductIds,
} from "./_resolveProduct";

export const PRODUCT_PRICE_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "sku", label: "SKU", required: true, type: "text", aliases: ["product_code", "code", "SKU"] },
  { key: "price_list", label: "Price List Name", required: true, type: "text", aliases: ["list", "tier", "price_book"] },
  { key: "price", label: "Price", required: true, type: "number", aliases: ["unit_price", "sale_price"] },
  { key: "currency", label: "Currency", required: false, type: "text", aliases: ["ccy", "currency_code"] },
  { key: "min_quantity", label: "Min Quantity", required: false, type: "number", aliases: ["min_qty", "tier_from"] },
  { key: "valid_from", label: "Valid From", required: false, type: "date", aliases: ["start", "effective_from"] },
  { key: "valid_to", label: "Valid To", required: false, type: "date", aliases: ["end", "effective_to"] },
];

/**
 * ADR-0074 batch handler — writes to `price_lists` (find-or-create) and
 * `price_list_items`. Idempotency: unique `(price_list_id, product_id, min_quantity)`.
 */
export function createProductPriceBatchMigrationHandler(ctx: ImportContext) {
  return async (rows: Record<string, any>[]): Promise<BatchResult> => {
    const errors: RowError[] = [];
    const resolved = await resolveProductIds(ctx, rows);

    // Find-or-create price lists by name.
    const names = Array.from(
      new Set(rows.map((r) => (r.price_list ? String(r.price_list).trim() : "")).filter(Boolean)),
    );
    const listByName = new Map<string, string>();
    if (names.length) {
      const { data } = await supabase
        .from("price_lists")
        .select("id, name")
        .eq("organization_id", ctx.orgId)
        .eq("business_id", ctx.businessId)
        .in("name", names);
      for (const l of (data ?? []) as { id: string; name: string }[]) listByName.set(l.name, l.id);
      const missing = names.filter((n) => !listByName.has(n));
      for (const name of missing) {
        const { data: created, error } = await supabase
          .from("price_lists")
          .insert({ organization_id: ctx.orgId, business_id: ctx.businessId, name, is_active: true } as any)
          .select("id")
          .single();
        if (!error && created) listByName.set(name, (created as any).id);
      }
    }

    let imported = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const productId = resolved.get(i);
      if (!productId) {
        errors.push({ rowIndex: i + 2, data: row, errors: `Unknown product (sku=${row.sku ?? ""})` });
        continue;
      }
      const listName = row.price_list ? String(row.price_list).trim() : "";
      const listId = listByName.get(listName);
      if (!listId) {
        errors.push({ rowIndex: i + 2, data: row, errors: `Price list "${listName}" could not be resolved` });
        continue;
      }
      if (row.price == null || isNaN(Number(row.price))) {
        errors.push({ rowIndex: i + 2, data: row, errors: "Missing/invalid price" });
        continue;
      }
      const { error } = await supabase.from("price_list_items").insert({
        price_list_id: listId,
        product_id: productId,
        unit_price: Number(row.price),
        min_quantity: row.min_quantity != null ? Number(row.min_quantity) : 1,
      } as any);
      if (error) {
        if ((error as any).code === "23505") imported++;
        else errors.push({ rowIndex: i + 2, data: row, errors: error.message });
      } else {
        imported++;
      }
    }
    return { total: rows.length, imported, skipped: errors.length, errors };
  };
}
