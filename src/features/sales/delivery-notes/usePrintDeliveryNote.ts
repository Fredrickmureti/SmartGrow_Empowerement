/**
 * usePrintDeliveryNote — the single delivery-note print path.
 *
 * Print is a document *event*, not a view concern: it builds the canonical
 * snapshot, materialises a `document_records` row and acknowledges the output
 * intent. Both the list page and the record page call this hook so the two
 * surfaces cannot drift.
 */
import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { fetchAndBuildSalesDeliveryNoteSnapshot } from "@/services/documents/snapshots/salesDeliveryNote";
import { ensureDocumentRecord } from "@/services/documents/ensureDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";
import { normalizeError } from "@/services/resilience";

export interface PrintableDeliveryNote {
  id: string;
  delivery_number?: string | null;
}

export function usePrintDeliveryNote() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();

  return useCallback(
    async (note: PrintableDeliveryNote) => {
      if (!currentBusiness?.id) {
        toast({
          title: "No company selected",
          description: "Pick a company before printing delivery notes.",
          variant: "destructive",
        });
        return;
      }
      if (!currentOrg?.id) {
        toast({
          title: "No organization",
          description: "Sign in to an organization before printing.",
          variant: "destructive",
        });
        return;
      }
      try {
        const built = await fetchAndBuildSalesDeliveryNoteSnapshot(supabase, note.id);
        const documentRecordId = await ensureDocumentRecord({
          kindCode: "sales.delivery_note",
          organizationId: currentOrg.id,
          sourceModule: "sales",
          sourceDocType: "delivery_note",
          sourceDocId: note.id,
          businessId: built.businessId ?? currentBusiness.id,
          branchId: built.branchId ?? null,
          partyKind: "customer",
          currency: built.currency,
          documentNumber: built.documentNumber,
          documentDate: built.documentDate,
          snapshot: built.snapshot,
        });
        await acknowledgeRecordPrint(
          { documentRecordId, triggeredSource: "manual" },
          toast,
          { label: `Delivery note ${note.delivery_number ?? ""}`.trim() },
        );
      } catch (err) {
        toast({
          title: "Print failed",
          description: normalizeError(err).message,
          variant: "destructive",
        });
      }
    },
    [currentOrg?.id, currentBusiness?.id, toast],
  );
}
