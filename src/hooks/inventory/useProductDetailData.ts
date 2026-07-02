/**
 * useProductDetailData — single composed query powering the ProductDetailPanel.
 *
 * One hook, one place, one cache key per (product, branch). Every tab in the
 * panel reads slices of the same payload — no per-tab query, no N+1, no
 * divergence between "what the Stock tab thinks on-hand is" and "what the
 * Overview header thinks on-hand is".
 *
 * Branch-true: on-hand always comes from `warehouse_stock`, never from the
 * cached `products.stock_quantity` aggregate.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ProductDetailData {
  product: any | null;
  warehouseStock: any[];
  warehouseStockLots: any[];
  packaging: any[];
  identifiers: any[];
  reorderRules: any[];
  recentMovements: any[];
  incomingPo: { totalQty: number; openOrders: number };
  velocityPerWeek: number;
}

interface Args {
  productId: string | null;
  organizationId: string | undefined;
  businessId: string | undefined;
  branchId: string | null;
  enabled?: boolean;
}

export function useProductDetailData({
  productId,
  organizationId,
  businessId,
  branchId,
  enabled = true,
}: Args) {
  return useQuery<ProductDetailData>({
    queryKey: [
      "product-detail-panel",
      productId,
      organizationId,
      businessId,
      branchId,
    ],
    enabled: enabled && !!productId && !!organizationId && !!businessId,
    staleTime: 30_000,
    queryFn: async () => {
      if (!productId || !organizationId || !businessId) {
        return emptyPayload();
      }

      // 1. Product master — we re-fetch even if the caller passed a Product
      //    object, because v1 of Product type omits is_lot_tracked /
      //    is_expiry_tracked / expiry_alert_days and the lot/expiry tab needs
      //    them.
      const { data: product, error: pErr } = await supabase
        .from("products")
        .select("*")
        .eq("id", productId)
        .maybeSingle();
      if (pErr) throw pErr;

      // 2. Warehouse stock (warehouse-scoped on-hand). The canonical
      //    `warehouse_stock` row is keyed on warehouse, not branch — so
      //    branch scoping is applied indirectly via the joined warehouse.
      let wsQ = (supabase as any)
        .from("warehouse_stock")
        .select("*, warehouses!inner(id, name, code, branch_id)")
        .eq("product_id", productId)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId);
      if (branchId) wsQ = wsQ.eq("warehouses.branch_id", branchId);
      const { data: warehouseStock, error: wsErr } = await wsQ;
      if (wsErr) throw wsErr;

      // 3. Lot / expiry quants (only meaningful for lot- or expiry-tracked
      //    products; the table is small so we always fetch)
      let lotsQ = (supabase as any)
        .from("warehouse_stock_lots")
        .select("*, warehouses!inner(name, branch_id), stock_lots!inner(id, lot_number, expiry_date)")
        .eq("product_id", productId)
        .eq("business_id", businessId)
        .gt("quantity", 0);
      if (branchId) lotsQ = lotsQ.eq("warehouses.branch_id", branchId);
      const { data: warehouseStockLots } = await lotsQ;

      // 4. Packaging (multi-UoM)
      const { data: packaging } = await supabase
        .from("product_packaging")
        .select("*")
        .eq("product_id", productId)
        .order("qty_in_base_uom", { ascending: false });

      // 5. Identifiers (barcodes per pack)
      const { data: identifiers } = await supabase
        .from("product_identifiers")
        .select("*")
        .eq("product_id", productId);

      // 6. Per-warehouse reorder rules
      let rrQ = (supabase as any)
        .from("product_reorder_rules")
        .select("*, warehouses!inner(name, branch_id)")
        .eq("product_id", productId)
        .eq("business_id", businessId);
      if (branchId) rrQ = rrQ.eq("warehouses.branch_id", branchId);
      const { data: reorderRules } = await rrQ;

      // 7. Recent movements (last 20)
      let mvQ = supabase
        .from("stock_movements")
        .select("*, warehouses(id, name)")
        .eq("product_id", productId)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId)
        .order("movement_date", { ascending: false })
        .limit(20);
      if (branchId) mvQ = mvQ.eq("branch_id", branchId);
      const { data: recentMovements } = await mvQ;

      // 8. Incoming POs — open purchase_order_items.
      //    purchase_orders.status enum: draft|sent|partial_received|received|cancelled
      let poQ = supabase
        .from("purchase_order_items")
        .select("quantity, quantity_received, purchase_orders!inner(id, status, business_id)")
        .eq("product_id", productId)
        .eq("purchase_orders.business_id", businessId)
        .in("purchase_orders.status", ["draft", "sent", "partial_received"]);
      const { data: poRows } = await poQ;
      let totalQty = 0;
      const openOrderIds = new Set<string>();
      for (const r of (poRows ?? []) as any[]) {
        const outstanding = Math.max(
          0,
          Number(r.quantity || 0) - Number(r.quantity_received || 0),
        );
        if (outstanding > 0) {
          totalQty += outstanding;
          if (r.purchase_orders?.id) openOrderIds.add(r.purchase_orders.id);
        }
      }

      // 9. Velocity — outbound base qty over last 28d / 4
      const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
      let velQ = supabase
        .from("stock_movements")
        .select("quantity, movement_type, movement_date")
        .eq("product_id", productId)
        .eq("business_id", businessId)
        .gte("movement_date", since);
      if (branchId) velQ = velQ.eq("branch_id", branchId);
      const { data: velRows } = await velQ;
      const outbound = (velRows ?? [])
        .filter((m: any) => Number(m.quantity) < 0)
        .reduce((s: number, m: any) => s + Math.abs(Number(m.quantity) || 0), 0);
      const velocityPerWeek = outbound / 4;

      return {
        product,
        warehouseStock: warehouseStock ?? [],
        warehouseStockLots: warehouseStockLots ?? [],
        packaging: packaging ?? [],
        identifiers: identifiers ?? [],
        reorderRules: reorderRules ?? [],
        recentMovements: recentMovements ?? [],
        incomingPo: { totalQty, openOrders: openOrderIds.size },
        velocityPerWeek,
      };
    },
  });
}

function emptyPayload(): ProductDetailData {
  return {
    product: null,
    warehouseStock: [],
    warehouseStockLots: [],
    packaging: [],
    identifiers: [],
    reorderRules: [],
    recentMovements: [],
    incomingPo: { totalQty: 0, openOrders: 0 },
    velocityPerWeek: 0,
  };
}