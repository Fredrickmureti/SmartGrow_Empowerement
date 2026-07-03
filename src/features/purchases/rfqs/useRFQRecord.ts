/**
 * useRFQRecord — canonical single-record fetch for the RFQ peek + record
 * page. Mirrors usePurchaseOrderRecord / useVendorCreditNoteRecord.
 */
import { useDocumentRecord } from "@/design-system";
import type { RFQWithRelations } from "@/hooks/useRFQs";

export function useRFQRecord(id: string | null | undefined) {
  return useDocumentRecord<
    RFQWithRelations & {
      vendors?: any[];
      items?: any[];
    }
  >({
    table: "rfqs",
    select: [
      "*",
      "items:rfq_items(*)",
      "vendors:rfq_vendors(*, vendor:contacts!vendor_id(id, name))",
    ].join(","),
    id,
    entityLabel: "RFQ",
  });
}