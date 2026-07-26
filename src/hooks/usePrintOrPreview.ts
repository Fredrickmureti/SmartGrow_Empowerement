/**
 * usePrintOrPreview — the single UI-level entry point for "print a
 * business document".
 *
 * Behaviour:
 *   1. Call `printClient.print({ intent: 'a4_document', ... })` with the
 *      current business/branch. `PrintClient` consults the policy resolver.
 *   2. If the resolver returns `askUser=true` (no policy configured), OR
 *      the print fails for any reason, fall back to opening the preview
 *      dialog by setting local preview state — the caller spreads that
 *      state into `<PrintPreviewDialog {...dialogProps} />`.
 *   3. If the resolver auto-printed (`autoPrint=true`), show a lightweight
 *      toast and skip the dialog.
 *
 * Phase C of the print pipeline plan collapsed the previous
 * `useDocumentPrint` shadow path into this hook. There is now exactly
 * one client-side hook for opening the preview dialog and exactly one
 * chokepoint (`printClient`) for actually rendering / dispatching.
 */

import { useCallback, useState } from "react";
import { printClient, type PrintIntent } from "@/services/printing/PrintClient";
import { useBusinesses } from "@/contexts/BusinessContext";
import { toast } from "sonner";
import type { DocumentCommunicationContext } from "@/components/communications/DocumentCommunicationBar";

export interface PrintOrPreviewRequest {
  documentType: string;
  documentId: string;
  title: string;
  /** Defaults to `a4_document` — override for receipts, labels, etc. */
  intent?: PrintIntent;
  /** Optional explicit branch scope. Falls back to null (business-wide policy). */
  branchId?: string | null;
  /**
   * Optional communication context for the preview footer (Email/SMS
   * actions). Threaded through unchanged for the ask_user fallback path.
   */
  communication?: DocumentCommunicationContext;
}

export function usePrintOrPreview() {
  const { currentBusiness } = useBusinesses();

  // Preview dialog state, owned by this hook (previously in useDocumentPrint).
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [printPreviewTitle, setPrintPreviewTitle] = useState("");
  const [printDocumentType, setPrintDocumentType] = useState<string>("");
  const [printDocumentId, setPrintDocumentId] = useState<string>("");
  const [printCommunication, setPrintCommunication] = useState<
    DocumentCommunicationContext | undefined
  >(undefined);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

  const openPreview = useCallback(
    (
      documentType: string,
      documentId: string,
      title: string,
      communication?: DocumentCommunicationContext,
    ) => {
      setPrintPreviewTitle(title);
      setPrintDocumentType(documentType);
      setPrintDocumentId(documentId);
      setPrintCommunication(communication);
      setPrintPreviewOpen(true);
    },
    [],
  );

  const printOrPreview = useCallback(
    async (req: PrintOrPreviewRequest) => {
      const businessId = currentBusiness?.id ?? null;

      // Fast path: no business context yet — the resolver would 400 anyway.
      if (!businessId) {
        openPreview(req.documentType, req.documentId, req.title, req.communication);
        return;
      }

      try {
        const result = await printClient.print({
          intent: req.intent ?? "a4_document",
          documentType: req.documentType,
          documentId: req.documentId,
          title: req.title,
          businessId,
          branchId: req.branchId ?? null,
          // Plan P3 Step 1 — one UUID per user click, becomes the ledger
          // collapse key on `(business_id, correlation_id)`.
          idempotencyKey:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

      openPreview(req.documentType, req.documentId, req.title, req.communication);
    },
    [currentBusiness?.id, openPreview],
  );

  /**
   * Drop-in replacement for the old `useDocumentPrint().generateDocument(...)`
   * shape. Routes through the policy resolver first and falls back to the
   * preview dialog for `ask_user` / errors.
   */
  const generateDocument = useCallback(
    (
      documentType: string,
      documentId: string,
      title: string,
      communication?: DocumentCommunicationContext,
    ) => printOrPreview({ documentType, documentId, title, communication }),
    [printOrPreview],
  );

  /**
   * Download the PDF for a document straight to the user's downloads,
   * bypassing the preview dialog. Delegates to `printClient.download`
   * so the `print_jobs` ledger records the intent.
   */
  const downloadPdf = useCallback(
    async (documentType: string, documentId: string, filename: string) => {
      setIsGeneratingPdf(true);
      try {
        const result = await printClient.download(
          {
            intent: "a4_document",
            documentType,
            documentId,
            businessId: currentBusiness?.id ?? null,
          },
          filename,
        );
        if (result.success) {
          toast.success("PDF downloaded");
        } else if (result.error) {
          toast.error("Error downloading PDF", { description: result.error });
        }
      } finally {
        setIsGeneratingPdf(false);
      }
    },
    [currentBusiness?.id],
  );

  return {
    printOrPreview,
    generateDocument,
    downloadPdf,
    // Passthrough for <PrintPreviewDialog {...dialogProps} />
    printPreviewOpen,
    setPrintPreviewOpen,
    printPreviewTitle,
    printDocumentType,
    printDocumentId,
    printCommunication,
    isGeneratingPdf,
  };
}
