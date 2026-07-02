/**
 * useProductUomLock — pre-flight read mirroring the server-side
 * `enforce_base_uom_immutable` trigger (see migration 2026-06-04).
 *
 * Returns `{ locked, reason }` so the Product edit form can disable the
 * Inventory Unit picker and explain to the operator that base UoM is
 * immutable once the product has any stock history or appears on any
 * transactional document. The trigger remains the authoritative guard;
 * this hook only powers UX so we don't have to round-trip a 400 to
 * discover the lock.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const PROBES: { table: string; label: string; nonZero?: boolean }[] = [
  { table: "stock_movements", label: "stock movements" },
  { table: "cost_layers", label: "cost layers" },
  { table: "warehouse_stock", label: "warehouse stock", nonZero: true },
  { table: "invoice_items", label: "invoices" },
  { table: "bill_items", label: "bills" },
  { table: "purchase_order_items", label: "purchase orders" },
  { table: "sales_order_items", label: "sales orders" },
  { table: "goods_receipt_items", label: "goods receipts" },
  { table: "pos_transaction_items", label: "POS transactions" },
  { table: "stock_adjustment_items", label: "stock adjustments" },
  { table: "stock_transfer_items", label: "stock transfers" },
  { table: "delivery_note_items", label: "delivery notes" },
  { table: "credit_note_items", label: "credit notes" },
];

export interface ProductUomLockResult {
  locked: boolean;
  reason: string | null;
}

export function useProductUomLock(productId: string | null | undefined) {
  return useQuery<ProductUomLockResult>({
    queryKey: ["product-uom-lock", productId],
    enabled: !!productId,
    staleTime: 30_000,
    queryFn: async () => {
      for (const probe of PROBES) {
        let q = supabase
          .from(probe.table as any)
          .select("id", { count: "exact", head: true })
          .eq("product_id", productId as string);
        if (probe.nonZero) q = q.neq("quantity", 0);
        const { count, error } = await q;
        if (error) {
          // Soft-fail: do NOT lock on a transient read error — the DB
          // trigger is still the source of truth at write time.
          continue;
        }
        if ((count ?? 0) > 0) {
          return {
            locked: true,
            reason: `This product has ${count} ${probe.label} on record.`,
          };
        }
      }
      return { locked: false, reason: null };
    },
  });
}
