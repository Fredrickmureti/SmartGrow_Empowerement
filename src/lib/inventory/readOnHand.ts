/**
 * readOnHand — single-source branch-scoped on-hand reader.
 *
 * `products.stock_quantity` is a company-wide cached aggregate maintained
 * by the `update_product_stock` trigger. It is NOT safe to drive any
 * branch-aware UI from it. This helper is the canonical way to ask
 * "how much do I have, in this (business, branch) context, for these
 * product ids?" — it always reads `warehouse_stock` and aggregates.
 */
import { supabase } from "@/integrations/supabase/client";

export interface OnHandRow {
  productId: string;
  onHand: number;
  reserved: number;
}

export interface GetProductOnHandArgs {
  orgId: string;
  businessId: string;
  branchId?: string | null;
  productIds: string[];
}

export async function getProductOnHand(
  args: GetProductOnHandArgs,
): Promise<Map<string, OnHandRow>> {
  const { orgId, businessId, branchId, productIds } = args;
  const map = new Map<string, OnHandRow>();
  if (!orgId || !businessId || productIds.length === 0) return map;

  let q = supabase
    .from("warehouse_stock")
    .select("product_id, quantity, reserved_quantity")
    .eq("organization_id", orgId)
    .eq("business_id", businessId)
    .in("product_id", productIds);
  if (branchId) q = q.eq("branch_id", branchId);

  const { data, error } = await q;
  if (error) throw error;

  for (const row of (data || []) as any[]) {
    const existing = map.get(row.product_id) ?? {
      productId: row.product_id,
      onHand: 0,
      reserved: 0,
    };
    existing.onHand += Number(row.quantity) || 0;
    existing.reserved += Number(row.reserved_quantity) || 0;
    map.set(row.product_id, existing);
  }
  return map;
}