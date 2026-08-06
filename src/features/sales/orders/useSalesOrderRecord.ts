import { useDocumentRecord } from "@/features/sales/record";
import type { SalesOrder } from "@/hooks/useSalesOrders";

export function useSalesOrderRecord(id: string | null | undefined) {
  return useDocumentRecord<SalesOrder>({
    table: "sales_orders",
    select: "*, contact:contacts(name, email), items:sales_order_items(*)",
    id,
    entityLabel: "Sales order",
  });
}
