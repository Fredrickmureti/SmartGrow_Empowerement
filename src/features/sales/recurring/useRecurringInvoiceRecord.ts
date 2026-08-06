import { useDocumentRecord } from "@/design-system/records";
import type { RecurringInvoice } from "@/hooks/useRecurringInvoices";

export function useRecurringInvoiceRecord(id: string | null | undefined) {
  return useDocumentRecord<RecurringInvoice>({
    table: "recurring_invoices",
    select: "*, contact:contacts(name, email), items:recurring_invoice_items(*)",
    id,
    entityLabel: "Recurring template",
  });
}
