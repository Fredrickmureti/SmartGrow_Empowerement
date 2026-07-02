import { useSalesDocumentRecord } from "@/features/sales/record";
import type { RecurringInvoice } from "@/hooks/useRecurringInvoices";

export function useRecurringInvoiceRecord(id: string | null | undefined) {
  return useSalesDocumentRecord<RecurringInvoice>({
    table: "recurring_invoices",
    select: "*, contact:contacts(name, email), items:recurring_invoice_items(*)",
    id,
    entityLabel: "Recurring template",
  });
}
