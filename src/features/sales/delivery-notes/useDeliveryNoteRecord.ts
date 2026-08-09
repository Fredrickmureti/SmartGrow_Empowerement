import { useDocumentRecord } from "@/design-system/records";
import type { DeliveryNote } from "@/hooks/useDeliveryNotes";

/**
 * `delivery_notes` has TWO foreign keys into `contacts`:
 *   - `contact_id`             → the customer the goods are shipped to
 *   - `received_by_contact_id` → the party who physically signed for them
 * PostgREST cannot resolve a bare `contacts(...)` embed against a table with
 * multiple relationships, so every embed here MUST name its constraint.
 */
export const DELIVERY_NOTE_RECORD_SELECT =
  "*, contact:contacts!delivery_notes_contact_id_fkey(name, email, phone), " +
  "received_by_contact:contacts!delivery_notes_received_by_contact_id_fkey(name), " +
  "sales_order:sales_orders(so_number), items:delivery_note_items(*)";

export function useDeliveryNoteRecord(id: string | null | undefined) {
  return useDocumentRecord<DeliveryNote>({
    table: "delivery_notes",
    select: DELIVERY_NOTE_RECORD_SELECT,
    id,
    entityLabel: "Delivery note",
  });
}
