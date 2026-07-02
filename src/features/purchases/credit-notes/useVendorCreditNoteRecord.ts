import { useDocumentRecord } from "@/design-system";
import type { VendorCreditNote } from "@/hooks/useVendorCreditNotes";

/**
 * useVendorCreditNoteRecord — canonical single-record fetch for the
 * Vendor Credit Note peek + record page. Uses the shared
 * `useDocumentRecord` scaffold so behaviour matches every other
 * business record (Invoice, PO, Bill, GRN, Sales Credit Note).
 */
export function useVendorCreditNoteRecord(id: string | null | undefined) {
  return useDocumentRecord<VendorCreditNote>({
    table: "vendor_credit_notes",
    select:
      "*, vendor:contacts(name, email), bill:bills(bill_number), items:vendor_credit_note_items(*)",
    id,
    entityLabel: "Vendor credit note",
  });
}
