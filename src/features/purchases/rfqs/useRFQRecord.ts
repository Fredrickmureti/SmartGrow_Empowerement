/**
 * useRFQRecord — canonical single-record fetch for the RFQ peek + record
 * page. Loads the full sourcing graph: lines, invitations, versioned
 * quotations and awards.
 */
import { useDocumentRecord } from "@/design-system";
import { RFQ_SELECT, type RFQWithRelations } from "@/hooks/useRFQs";

export function useRFQRecord(id: string | null | undefined) {
  return useDocumentRecord<RFQWithRelations>({
    table: "rfqs",
    select: RFQ_SELECT,
    id,
    entityLabel: "RFQ",
  });
}
