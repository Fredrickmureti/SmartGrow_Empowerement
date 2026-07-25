import { useState } from "react";
import { invokeWithAuth } from "@/integrations/supabase/invokeWithAuth";
import { useToast } from "@/hooks/use-toast";
import { downloadPdfBlob, printPdfInPage } from "@/services/printing/pdfUtils";
import type { DocumentCommunicationContext } from "@/components/communications/DocumentCommunicationBar";
import { normalizeError } from "@/services/resilience";

type DocumentType = "invoice" | "estimate" | "proforma" | "credit_note" | "purchase_order" | "receipt" | "pos_receipt" | "sales_order" | "delivery_note" | "sales_return" | "customer_statement" | "vendor_statement" | "legal_recipient_statement" | "bill";
type EdgeFunctionBinary = Blob | ArrayBuffer | string;

/**
 * Stage P3 (ADR-0008): paper override accepted by every consumer.
 * Default behaviour (A4 PDF) is preserved when omitted.
 */
export type PaperFormatOption =
  | "a4" | "letter" | "a5" | "80mm" | "58mm" | "40mm"
  | { widthMm: number; heightMm: number | "auto" };

export function useDocumentPrint() {
  const { toast } = useToast();
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [printPreviewTitle, setPrintPreviewTitle] = useState("");
  const [printDocumentType, setPrintDocumentType] = useState<string>("");
  const [printDocumentId, setPrintDocumentId] = useState<string>("");
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  // Communication context for the current preview (Email/SMS actions in the
  // preview footer). Set when the caller passes one to generateDocument.
  const [printCommunication, setPrintCommunication] = useState<DocumentCommunicationContext | undefined>(undefined);

  /**
   * Open the preview dialog with documentType + documentId.
   * The dialog itself fetches the actual PDF from the server.
   *
   * Optionally accepts a `communication` context so the preview footer
   * can show Send via Email / Send via SMS for this exact document
   * without each page re-implementing those actions.
   */
  const generateDocument = async (
    documentType: DocumentType,
    documentId: string,
    title: string,
    communication?: DocumentCommunicationContext,
  ) => {
    setPrintPreviewTitle(title);
    setPrintDocumentType(documentType);
    setPrintDocumentId(documentId);
    setPrintCommunication(communication);
    setPrintPreviewOpen(true);
  };

  /**
   * Download a server-side generated PDF directly.
   * V3 (ADR-0008): omit `format` / `paperFormat` unless caller passes one,
   * so the server-side `document_print_policies` resolver wins. Default
   * behaviour (A4 PDF for unconfigured tenants) is preserved by the resolver.
   */
  const downloadPdf = async (
    documentType: DocumentType,
    documentId: string,
    filename: string,
    paperFormat?: PaperFormatOption,
    renderMode?: "pdf" | "escpos",
    extraBody?: Record<string, unknown>,
  ) => {
    setIsGeneratingPdf(true);
    try {
      // Download is an EXPLICIT PDF request — always send `format: "pdf"`
      // (unless the caller overrode it). Without this, tenants whose
      // print policy is thermal/ESC-POS get raw ESC/POS bytes saved as
      // `.pdf`, which fails to open ("Error loading document"). With the
      // explicit format, `coercePaperRenderMode` switches thermal paper
      // to A4 PDF for the download artifact.
      const body: Record<string, unknown> = {
        documentType,
        documentId,
        format: renderMode ?? "pdf",
        ...(extraBody ?? {}),
      };
      if (paperFormat) body.paperFormat = paperFormat;
      const { data, error } = await invokeWithAuth<EdgeFunctionBinary, Record<string, unknown>>(
        "generate-document",
        { body },
      );

      if (error) throw error;
      if (data === null) throw new Error("No PDF data returned by the document service.");

      const raw: Blob = data instanceof Blob ? data : new Blob([data]);
      // Defense in depth: validate %PDF magic bytes before saving so a
      // misconfigured policy never produces a corrupt file on disk.
      let head = "";
      try {
        const headBuf = await raw.slice(0, 4).arrayBuffer();
        head = new TextDecoder().decode(new Uint8Array(headBuf));
      } catch {
        // fall through — empty head will fail the check below
      }
      if (head !== "%PDF") {
        throw new Error(
          "Server returned a non-PDF payload (likely ESC/POS bytes from a " +
          "thermal print policy). Refusing to save a corrupt file."
        );
      }
      const blob = raw.type === "application/pdf"
        ? raw
        : new Blob([raw], { type: "application/pdf" });
      downloadPdfBlob(blob, `${filename}.pdf`);

      toast({ title: "PDF downloaded" });
    } catch (error: any) {
      toast({
        title: "Error downloading PDF",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  /**
   * Generate a server-side PDF and print it in-page (no new tab).
   * V3: same policy-deferral behaviour as `downloadPdf`.
   */
  const printDocument = async (
    documentType: DocumentType,
    documentId: string,
    title: string,
    paperFormat?: PaperFormatOption,
    renderMode?: "pdf" | "escpos",
    extraBody?: Record<string, unknown>,
  ) => {
    setIsGeneratingPdf(true);
    try {
      // Same root-cause guard as `downloadPdf`: in-page print must be a
      // real PDF, never ESC/POS bytes coerced from a thermal policy.
      const body: Record<string, unknown> = {
        documentType,
        documentId,
        format: renderMode ?? "pdf",
        ...(extraBody ?? {}),
      };
      if (paperFormat) body.paperFormat = paperFormat;
      const { data, error } = await invokeWithAuth<EdgeFunctionBinary, Record<string, unknown>>(
        "generate-document",
        { body },
      );

      if (error) throw error;
      if (data === null) throw new Error("No PDF data returned by the document service.");

      const raw: Blob = data instanceof Blob ? data : new Blob([data]);
      let head = "";
      try {
        const headBuf = await raw.slice(0, 4).arrayBuffer();
        head = new TextDecoder().decode(new Uint8Array(headBuf));
      } catch {
        // ignore
      }
      if (head !== "%PDF") {
        throw new Error(
          "Server returned a non-PDF payload. Refusing to print a corrupt file."
        );
      }
      const blob = raw.type === "application/pdf"
        ? raw
        : new Blob([raw], { type: "application/pdf" });
      await printPdfInPage(blob);
    } catch (error: any) {
      toast({
        title: "Error printing document",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  /**
   * Stage P5 (ADR-0008): download raw ESC/POS bytes for a thermal printer.
   * Routes through the same `generate-document` engine — no parallel
   * pipeline. The caller can hand the bytes to `resolveTransport(...)` for
   * direct printing or save them as `.bin` for LPR-style queues.
   */
  const downloadEscPos = async (
    documentType: DocumentType,
    documentId: string,
    filename: string,
    paperFormat: "80mm" | "58mm" = "80mm",
  ): Promise<Uint8Array | null> => {
    setIsGeneratingPdf(true);
    try {
      const { data, error } = await invokeWithAuth<EdgeFunctionBinary, Record<string, unknown>>(
        "generate-document",
        {
        body: { documentType, documentId, format: "escpos", paperFormat, renderMode: "escpos" },
        },
      );
      if (error) throw error;
      if (data === null) throw new Error("No ESC/POS data returned by the document service.");
      const blob: Blob = data instanceof Blob ? data : new Blob([data], { type: "application/octet-stream" });
      const buf = new Uint8Array(await blob.arrayBuffer());
      // Save as .bin so the user can verify or hand off to a printer service.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filename}.bin`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
      toast({ title: "Thermal receipt downloaded" });
      return buf;
    } catch (err: any) {
      toast({ title: "Error generating thermal receipt", description: normalizeError(err).message, variant: "destructive" });
      return null;
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  return {
    printPreviewOpen,
    setPrintPreviewOpen,
    printPreviewTitle,
    printDocumentType,
    printDocumentId,
    printCommunication,
    isGeneratingPdf,
    generateDocument,
    downloadPdf,
    printDocument,
    downloadEscPos,
  };
}
