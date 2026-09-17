/**
 * useLendingDocumentPrint — the Print disposition for lending paperwork.
 *
 * Twin of `useRecordPrint` in finance: freeze the SAME snapshot the preview
 * and the download are drawn from (through the document registry), then
 * submit the routing intent. No second renderer, no bespoke print path, and
 * no privileged client — the snapshot builder reads the loan under the
 * caller's own session, so an unauthorised loan id yields no rows and the
 * freeze fails before anything is queued.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { resolveSourceDocumentRecordId } from "@/services/documents/resolveSourceDocumentRecord";
import { acknowledgeRecordPrint } from "@/services/printing/acknowledge";

export function useLendingDocumentPrint() {
  const [printing, setPrinting] = useState<string | null>(null);

  const print = useCallback(
    async (documentType: string, documentId: string, label: string) => {
      if (!documentId || printing) return;
      setPrinting(documentType);
      try {
        const documentRecordId = await resolveSourceDocumentRecordId(
          documentType,
          documentId,
        );
        await acknowledgeRecordPrint(
          { documentRecordId, triggeredSource: "manual" },
          ({ title, description, variant }) =>
            variant === "destructive"
              ? toast.error(title, { description })
              : toast.success(title, { description }),
          { label },
        );
      } catch (err) {
        toast.error("Print failed", {
          description:
            err instanceof Error ? err.message : "The document could not be printed.",
        });
      } finally {
        setPrinting(null);
      }
    },
    [printing],
  );

  return { print, printing };
}

export default useLendingDocumentPrint;
