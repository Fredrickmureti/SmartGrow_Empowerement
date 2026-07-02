import { useDocumentRecord } from "@/design-system";
import type { Bill } from "@/hooks/useBills";

/**
 * useBillRecord — canonical single-record fetch for the Bill peek +
 * record page. Uses the shared `useDocumentRecord` scaffold so
 * behaviour matches every other business record (Invoice, PO, GRN,
 * Vendor Credit Note, Purchase Return).
 */
export function useBillRecord(id: string | null | undefined) {
  return useDocumentRecord<Bill>({
    table: "bills",
    select: "*, vendor:contacts(name, email), items:bill_items(*)",
    id,
    entityLabel: "Bill",
  });
}
