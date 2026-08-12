/**
 * useRecordDownload — the Download disposition for Purchases documents.
 *
 * Preview, Print and Download are three different verbs and this codebase
 * keeps them apart (see DocumentPreviewProvider's header comment). Download
 * renders the SAME frozen snapshot the printed copy is drawn from through
 * `downloadExport` and hands the bytes to the browser — it never routes to a
 * physical device and never opens a print job.
 *
 * Twin of `useRecordPrint`; both are consumed by the per-document
 * `use<Doc>Actions` hooks so the row menu, the peek and the record page all
 * offer the same output vocabulary.
 */
import { useCallback, useState } from "react";

import { useToast } from "@/hooks/use-toast";
import { downloadExport } from "@/services/exports/documentExport";

/**
 * Only document types registered in `resolveSourceDocumentRecord` can be
 * downloaded — a download renders a frozen snapshot, so a type without a
 * snapshot builder has nothing to render.
 */
export type RecordDownloadKind =
  | "bill"
  | "purchase_order"
  | "purchase_return"
  | "rfq"
  | "purchase_requisition"
  | "vendor_credit_note";

export function useRecordDownload(kind: RecordDownloadKind) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);

  const download = useCallback(
    async (docId: string, filename: string) => {
      if (!docId || downloading) return;
      setDownloading(true);
      try {
        const result = await downloadExport({
          documentType: kind,
          documentId: docId,
          format: "pdf",
          filename,
        });
        if (!result.success) {
          toast({
            title: "Download failed",
            description: result.error ?? "The document could not be rendered.",
            variant: "destructive",
          });
        }
      } finally {
        setDownloading(false);
      }
    },
    [kind, downloading, toast],
  );

  return { download, downloading };
}

export default useRecordDownload;
