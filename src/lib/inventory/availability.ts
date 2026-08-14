/**
 * availability — the ONLY client seam for "how much can I sell/pick?".
 *
 * ADR 0142: availability is a server-side decision. The browser must never
 * compute `quantity - reserved_quantity` itself: that formula ignores stock
 * in transit, quarantined and blocked locations, and expired reservations,
 * and it drifts the moment the rule changes.
 *
 * `warehouse_stock` remains a legitimate READ MODEL for displaying on-hand
 * and reserved figures (see `readOnHand.ts`) — it is now projected from
 * `stock_quants`. Use this module whenever the number drives a decision
 * (can I add to cart, can I confirm, can I pick, do I warn).
 */
import { supabase } from "@/integrations/supabase/client";

export interface StockAvailability {
  productId: string;
  /** Sellable physical stock: internal, unblocked, non-transit locations. */
  onHand: number;
  /** Open reservation rows (not released, not expired). */
  reserved: number;
  /** Quarantined or blocked locations. */
  blocked: number;
  /** Transit locations and in-transit warehouses. */
  inTransit: number;
  /** onHand − reserved. May be negative when stock is oversold. */
  available: number;
}

export interface ResolveAvailabilityArgs {
  productId: string;
  businessId: string;
  branchId?: string | null;
  /** Omit to aggregate across every warehouse in scope. */
  warehouseId?: string | null;
}

const empty = (productId: string): StockAvailability => ({
  productId,
  onHand: 0,
  reserved: 0,
  blocked: 0,
  inTransit: 0,
  available: 0,
});

export async function resolveAvailability(
  args: ResolveAvailabilityArgs,
): Promise<StockAvailability> {
  const { productId, businessId, branchId, warehouseId } = args;
  if (!productId || !businessId) return empty(productId);

  const { data, error } = await supabase.rpc("resolve_stock_availability", {
    p_product_id: productId,
    p_business_id: businessId,
    p_branch_id: branchId ?? null,
    p_warehouse_id: warehouseId ?? null,
  });
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | undefined;
  if (!row) return empty(productId);

  return {
    productId,
    onHand: Number(row.on_hand) || 0,
    reserved: Number(row.reserved) || 0,
    blocked: Number(row.blocked) || 0,
    inTransit: Number(row.in_transit) || 0,
    available: Number(row.available) || 0,
  };
}

/**
 * Batch reader — ONE call to the canonical engine
 * (`resolve_stock_availability_batch`) for every product in scope.
 * Products with no stock come back as zero rows.
 */
export async function resolveAvailabilityFor(
  productIds: string[],
  scope: Omit<ResolveAvailabilityArgs, "productId">,
): Promise<Map<string, StockAvailability>> {
  const unique = Array.from(new Set(productIds.filter(Boolean)));
  const map = new Map<string, StockAvailability>();
  if (unique.length === 0 || !scope.businessId) return map;

  const { data, error } = await supabase.rpc(
    "resolve_stock_availability_batch" as never,
    {
      p_product_ids: unique,
      p_business_id: scope.businessId,
      p_branch_id: scope.branchId ?? null,
      p_warehouse_id: scope.warehouseId ?? null,
    } as never,
  );
  if (error) throw error;

  for (const row of ((data as unknown as Record<string, unknown>[]) ?? [])) {
    const productId = String(row.product_id);
    map.set(productId, {
      productId,
      onHand: Number(row.on_hand) || 0,
      reserved: Number(row.reserved) || 0,
      blocked: Number(row.blocked) || 0,
      inTransit: Number(row.in_transit) || 0,
      available: Number(row.available) || 0,
    });
  }
  for (const id of unique) if (!map.has(id)) map.set(id, empty(id));
  return map;
}

