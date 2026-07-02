import { useSalesDocumentRecord } from "@/features/sales/record";
import type { CreditNote } from "@/hooks/useCreditNotes";

export function useCreditNoteRecord(id: string | null | undefined) {
  return useSalesDocumentRecord<CreditNote>({
    table: "credit_notes",
    select: "*, contact:contacts(name, email), items:credit_note_items(*)",
    id,
    entityLabel: "Credit note",
  });
}
