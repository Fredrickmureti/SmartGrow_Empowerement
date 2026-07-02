import { useDocumentRecord } from "@/design-system";
import type { PurchaseOrder } from "@/hooks/usePurchaseOrders";

/**
 * usePurchaseOrderRecord — canonical single-record fetch for the
 * Purchase Order peek + record page.
 */
export function usePurchaseOrderRecord(id: string | null | undefined) {
  return useDocumentRecord<PurchaseOrder>({
    table: "purchase_orders",
    select:
      "*, vendor:contacts(name, email), items:purchase_order_items(*)",
    id,
    entityLabel: "Purchase order",
  });
}
