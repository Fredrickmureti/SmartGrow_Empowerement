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
      `*, vendor:contacts(name, email),
       contract:procurement_contracts!purchase_orders_contract_id_fkey(id, contract_number, title, currency, status),
       deliver_to_warehouse:warehouses!purchase_orders_deliver_to_warehouse_id_fkey(name),
       deliver_to_branch:branches!purchase_orders_deliver_to_branch_id_fkey(name),
       items:purchase_order_items(*)`,
    id,
    entityLabel: "Purchase order",
  });
}
