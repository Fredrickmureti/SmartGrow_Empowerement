import { useDocumentRecord } from "@/design-system/records";
import type { SalesOrder } from "@/hooks/useSalesOrders";

export function useSalesOrderRecord(id: string | null | undefined) {
  return useDocumentRecord<SalesOrder>({
    table: "sales_orders",
    select: "*, contact:contacts!sales_orders_contact_id_fkey(name, email), items:sales_order_items(*)",
    id,
    entityLabel: "Sales order",
  });
}
