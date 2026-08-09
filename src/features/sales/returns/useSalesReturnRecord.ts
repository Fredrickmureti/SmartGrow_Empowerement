import { useDocumentRecord } from "@/design-system/records";
import type { SalesReturn } from "@/hooks/useSalesReturns";

export function useSalesReturnRecord(id: string | null | undefined) {
  return useDocumentRecord<SalesReturn>({
    table: "sales_returns",
    select:
      "*, contact:contacts(name, email), invoice:invoices(invoice_number, total, amount_paid), wms_return_order:wms_return_orders(id, return_number, status), items:sales_return_items(*)",
    id,
    entityLabel: "Sales return",
  });
}
