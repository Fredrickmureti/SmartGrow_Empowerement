/**
 * Lending → Documents menu.
 *
 * The single affordance through which lending paperwork leaves the system.
 * It owns no rendering: Preview goes through the app-wide
 * `DocumentPreviewProvider` (render-only, no ledger row, no device) and
 * Download goes through `downloadExport`, which freezes the same snapshot the
 * PDF is drawn from. No second renderer, no bespoke PDF path.
 */
import { useState } from "react";
import { Download, FileSearch, FileText, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { downloadExport } from "@/services/exports/documentExport";

export interface LendingDocumentTarget {
  /** Registered source document type, e.g. `loan_agreement`. */
  documentType: string;
  documentId: string;
  title: string;
  /** Filename offered to the browser; extension is appended by the exporter. */
  filename: string;
}

interface LendingDocumentsMenuProps {
  documents: LendingDocumentTarget[];
  label?: string;
}

export function LendingDocumentsMenu({
  documents,
  label = "Documents",
}: LendingDocumentsMenuProps) {
  const { preview } = useDocumentPreview();
  const [busy, setBusy] = useState<string | null>(null);

  if (documents.length === 0) return null;

  const download = async (doc: LendingDocumentTarget) => {
    setBusy(doc.documentType);
    const result = await downloadExport({
      documentType: doc.documentType,
      documentId: doc.documentId,
      format: "pdf",
      filename: doc.filename,
    });
    setBusy(null);
    if (!result.success) {
      toast.error(`Could not generate ${doc.title}`, { description: result.error });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          {busy ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileText className="mr-1.5 h-3.5 w-3.5" />
          )}
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Preview</DropdownMenuLabel>
        {documents.map((doc) => (
          <DropdownMenuItem
            key={`preview-${doc.documentType}`}
            onSelect={() =>
              preview({
                documentType: doc.documentType,
                documentId: doc.documentId,
                title: doc.title,
                filename: doc.filename,
              })
            }
          >
            <FileSearch className="mr-2 h-3.5 w-3.5" />
            {doc.title}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Download PDF</DropdownMenuLabel>
        {documents.map((doc) => (
          <DropdownMenuItem
            key={`download-${doc.documentType}`}
            disabled={busy === doc.documentType}
            onSelect={(event) => {
              event.preventDefault();
              void download(doc);
            }}
          >
            <Download className="mr-2 h-3.5 w-3.5" />
            {doc.title}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default LendingDocumentsMenu;
