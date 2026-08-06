import { useDocumentRecord } from "@/design-system/records";
import type { DeliveryNote } from "@/hooks/useDeliveryNotes";

export function useDeliveryNoteRecord(id: string | null | undefined) {
  return useDocumentRecord<DeliveryNote>({
    table: "delivery_notes",
    select:
      "*, contact:contacts(name, email), sales_order:sales_orders(so_number), items:delivery_note_items(*)",
    id,
    entityLabel: "Delivery note",
  });
}
