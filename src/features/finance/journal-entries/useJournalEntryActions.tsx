/**
 * useJournalEntryActions — the single declaration of the output vocabulary
 * for a journal entry (Preview / Print / Download), rendered identically by
 * the record page, the peek sheet and the list row menu so the three
 * surfaces cannot drift.
 *
 * A journal voucher is internal accounting evidence: there is no email
 * disposition, and a not-yet-posted entry still prints (stamped as a draft
 * by the layout) because review-before-posting is the normal workflow.
 */
import { useMemo } from "react";
import { Download, FileSearch, Printer } from "lucide-react";

import type { DocumentAction } from "@/design-system/records";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { useRecordPrint } from "@/features/finance/record/useRecordPrint";
import { useRecordDownload } from "@/features/finance/record/useRecordDownload";

interface JournalEntryRef {
  id: string;
  entry_number?: string | null;
}

export function useJournalEntryActions(
  entry: JournalEntryRef | null | undefined,
): DocumentAction[] {
  const { preview } = useDocumentPreview();
  const { print, printing } = useRecordPrint("journal_entry");
  const { download, downloading } = useRecordDownload("journal_entry");

  return useMemo<DocumentAction[]>(() => {
    if (!entry?.id) return [];
    const number = entry.entry_number ?? entry.id.slice(0, 8);
    const slug = `journal-voucher-${number}`;

    return [
      {
        id: "preview",
        label: "Preview",
        icon: FileSearch,
        group: "output",
        onSelect: () =>
          preview({
            documentType: "journal_entry",
            documentId: entry.id,
            title: `Journal Voucher ${number}`,
            filename: slug,
          }),
      },
      {
        id: "print",
        label: printing ? "Generating…" : "Print",
        icon: Printer,
        group: "output",
        disabled: printing,
        onSelect: () => void print(entry.id, `Journal Voucher ${number}`),
      },
      {
        id: "download",
        label: downloading ? "Preparing…" : "Download PDF",
        icon: Download,
        group: "output",
        disabled: downloading,
        onSelect: () => void download(entry.id, slug),
      },
    ];
  }, [entry?.id, entry?.entry_number, preview, print, printing, download, downloading]);
}

export default useJournalEntryActions;
