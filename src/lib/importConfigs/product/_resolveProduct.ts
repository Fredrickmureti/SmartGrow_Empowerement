/**
 * Shared product-resolution helpers for the split ADR-0074 import handlers.
 *
 * Each secondary handler (barcode, batch, warehouseStock, price, supplier)
 * needs to attach rows to an existing product. Resolution order:
 *   1. exact SKU match within (organization_id, business_id)
 *   2. exact barcode match via product_identifiers.code_norm
 *
 * Unresolved rows do NOT fault the batch — they surface in the `errors`
 * array so the migration wizard can show a per-row skip reason.
 */
import { supabase } from "@/integrations/supabase/client";

export interface ImportContext {
  orgId: string;
  businessId: string;
  branchId?: string | null;
  warehouseId?: string | null;
}

export interface RowError {
  rowIndex: number;
  data: Record<string, any>;
  errors: string;
}

export interface BatchResult {
  total: number;
  imported: number;
  skipped: number;
  errors: RowError[];
}

function norm(code: string | null | undefined): string | null {
  if (!code) return null;
  const s = String(code).trim().toUpperCase();
  return s.length ? s : null;
}

/**
 * Resolve a batch of rows to product ids. Returns a Map keyed by row
 * index. Rows without a matching product are absent from the map.
 */
export async function resolveProductIds(
  ctx: ImportContext,
  rows: Record<string, any>[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!rows.length) return out;

  const skus = Array.from(new Set(rows.map((r) => (r.sku ? String(r.sku).trim() : "")).filter(Boolean)));
  const barcodes = Array.from(
    new Set(rows.map((r) => norm(r.barcode)).filter((b): b is string => !!b)),
  );

  const bySku = new Map<string, string>();
  if (skus.length) {
    const { data } = await supabase
      .from("products")
      .select("id, sku")
      .eq("organization_id", ctx.orgId)
      .eq("business_id", ctx.businessId)
      .in("sku", skus);
    for (const p of (data ?? []) as { id: string; sku: string | null }[]) {
      if (p.sku) bySku.set(p.sku, p.id);
    }
  }

  const byBarcode = new Map<string, string>();
  if (barcodes.length) {
    const { data } = await supabase
      .from("product_identifiers")
      .select("product_id, code_norm")
      .eq("business_id", ctx.businessId)
      .in("code_norm", barcodes);
    for (const r of (data ?? []) as { product_id: string; code_norm: string }[]) {
      byBarcode.set(r.code_norm, r.product_id);
    }
  }

  rows.forEach((row, idx) => {
    const sku = row.sku ? String(row.sku).trim() : "";
    if (sku && bySku.has(sku)) {
      out.set(idx, bySku.get(sku)!);
      return;
    }
    const bc = norm(row.barcode);
    if (bc && byBarcode.has(bc)) {
      out.set(idx, byBarcode.get(bc)!);
    }
  });

  return out;
}

export function emptyResult(total: number): BatchResult {
  return { total, imported: 0, skipped: 0, errors: [] };
}