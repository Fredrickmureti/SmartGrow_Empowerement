/**
 * usePrintOrPreview — shared migration helper for the 12 "shadow path"
 * surfaces still listed in `eslint-rules/no-document-print-shadow-path.js`.
 *
 * Wave B1 Step 3 (ADR-0026). Pages currently do:
 *
 *   const { generateDocument, ...rest } = useDocumentPrint();
 *   ...
 *   generateDocument("invoice", inv.id, `Invoice ${inv.invoice_number}`);
 *
 * which *always* opens the preview dialog. That is wrong: when a business
 * has configured a print policy (branch printer + auto_print), the button
 * should route straight through `printClient.print()` without the dialog.
 *
 * This hook wraps both, so a page migration is a one-line change:
 *
 *   const { printOrPreview, ...dialogProps } = usePrintOrPreview();
 *   ...
 *   printOrPreview({ documentType: "invoice", documentId: inv.id, title });
 *
 * Behaviour:
 *   1. Call `printClient.print({ intent: 'a4_document', ... })` with the
 *      current business/branch. `PrintClient` consults the policy resolver.
 *   2. If the resolver returns `askUser=true` (no policy configured), OR
 *      the print fails for any reason, fall back to opening the legacy
 *      preview dialog via `useDocumentPrint().generateDocument(...)`.
 *   3. If the resolver auto-printed (`autoPrint=true`), show a lightweight
 *      toast and skip the dialog.
 *
 * The hook re-exports every field `useDocumentPrint()` exposes so pages
 * can spread it into `<PrintPreviewDialog {...dialogProps} />` unchanged.
 *
 * NB: this hook itself imports `useDocumentPrint`, so it must be on the
 * ESLint allowlist. It intentionally is — see `no-document-print-shadow-path.js`.
 */

import { useCallback } from "react";
import { useDocumentPrint } from "@/hooks/useDocumentPrint";
import { printClient, type PrintIntent } from "@/services/printing/PrintClient";
import { useBusinesses } from "@/contexts/BusinessContext";
import { toast } from "sonner";

export interface PrintOrPreviewRequest {
  documentType: string;
  documentId: string;
  title: string;
  /** Defaults to `a4_document` — override for receipts, labels, etc. */
  intent?: PrintIntent;
  /** Optional explicit branch scope. Falls back to null (business-wide policy). */
  branchId?: string | null;
  /**
   * When the resolver hits `askUser`, additional context passed to
   * `generateDocument()` (e.g. email addresses for the Send action).
   */
  communication?: Parameters<
    ReturnType<typeof useDocumentPrint>["generateDocument"]
  >[3];
}

export function usePrintOrPreview() {
  const docPrint = useDocumentPrint();
  const { currentBusiness } = useBusinesses();

  const printOrPreview = useCallback(
    async (req: PrintOrPreviewRequest) => {
      const businessId = currentBusiness?.id ?? null;

      // Fast path: no business context yet — the resolver would 400 anyway.
      if (!businessId) {
        return docPrint.generateDocument(
          req.documentType,
          req.documentId,
          req.title,
          req.communication,
        );
      }

      try {
        const result = await printClient.print({
          intent: req.intent ?? "a4_document",
          documentType: req.documentType,
          documentId: req.documentId,
          title: req.title,
          businessId,
          branchId,
        });

        if (result.success && result.transport !== "ask_user" && result.transport !== "none") {
          if (result.policy?.autoPrint) {
            toast.success(`Sent ${req.title} to ${result.policy.paperFormat.toUpperCase()} printer`);
          }
          return;
        }
        // Fall through to preview dialog for ask_user / failed transports.
      } catch (err) {
        // Never surface as an error; the dialog is a safe fallback.
        console.warn("[printOrPreview] falling back to preview dialog:", err);
      }

      return docPrint.generateDocument(
        req.documentType,
        req.documentId,
        req.title,
        req.communication,
      );
    },
    [currentBusiness?.id, branchId, docPrint],
  );

  return {
    printOrPreview,
    // Passthrough for the <PrintPreviewDialog {...dialogProps} /> spread.
    printPreviewOpen: docPrint.printPreviewOpen,
    setPrintPreviewOpen: docPrint.setPrintPreviewOpen,
    printPreviewTitle: docPrint.printPreviewTitle,
    printDocumentType: docPrint.printDocumentType,
    printDocumentId: docPrint.printDocumentId,
    printCommunication: docPrint.printCommunication,
    isGeneratingPdf: docPrint.isGeneratingPdf,
    downloadPdf: docPrint.downloadPdf,
  };
}
