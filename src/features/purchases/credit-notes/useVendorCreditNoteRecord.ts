import { useDocumentRecord } from "@/design-system";
import type { VendorCreditNote } from "@/hooks/useVendorCreditNotes";

/**
 * useVendorCreditNoteRecord — canonical single-record fetch for the
 * Vendor Credit Note peek + record page. Uses the shared
 * `useDocumentRecord` scaffold so behaviour matches every other
 * business record (Invoice, PO, Bill, GRN, Sales Credit Note).
 *
 * ADR 0132: the upstream lineage (purchase return / goods receipt / purchase
 * order) is embedded here so the record page can *show* the chain the credit
 * came from rather than only its raw ids.
 */
export function useVendorCreditNoteRecord(id: string | null | undefined) {
  return useDocumentRecord<VendorCreditNote>({
    table: "vendor_credit_notes",
    select:
      "*, vendor:contacts(name, email), bill:bills(bill_number), source_return:purchase_returns(return_number), goods_receipt:goods_receipts(receipt_number), purchase_order:purchase_orders(po_number), items:vendor_credit_note_items(*)",
    id,
    entityLabel: "Vendor credit note",
  });
}
