import { useDocumentRecord } from "@/features/sales/record";
import type { SalesReturn } from "@/hooks/useSalesReturns";

export function useSalesReturnRecord(id: string | null | undefined) {
  return useDocumentRecord<SalesReturn>({
    table: "sales_returns",
    select:
      "*, contact:contacts(name, email), invoice:invoices(invoice_number, total, amount_paid), items:sales_return_items(*)",
    id,
    entityLabel: "Sales return",
  });
}
