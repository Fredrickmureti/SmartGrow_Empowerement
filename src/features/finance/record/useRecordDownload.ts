/**
 * useRecordDownload (finance) — the Download disposition for finance
 * documents. Renders the SAME frozen snapshot the printed copy is drawn
 * from through `downloadExport`; it never routes to a device.
 */
import { useCallback, useState } from "react";

import { useToast } from "@/hooks/use-toast";
import { downloadExport } from "@/services/exports/documentExport";

export type FinanceRecordDownloadKind = "journal_entry";

export function useRecordDownload(kind: FinanceRecordDownloadKind) {
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
