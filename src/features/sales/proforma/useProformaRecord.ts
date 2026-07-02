import { useSalesDocumentRecord } from "@/features/sales/record";
import type { ProformaInvoice } from "@/hooks/useProformaInvoices";

export function useProformaRecord(id: string | null | undefined) {
  return useSalesDocumentRecord<ProformaInvoice>({
    table: "proforma_invoices",
    select: "*, contact:contacts(name, email), items:proforma_invoice_items(*)",
    id,
    entityLabel: "Proforma",
  });
}
