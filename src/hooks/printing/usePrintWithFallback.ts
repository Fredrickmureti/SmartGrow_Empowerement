/**
 * usePrintWithFallback — dispatch a document, and degrade visibly when no
 * printer answers.
 *
 * ## Why this is a printing concern, not a hardware one
 *
 * This hook renders and dispatches a *document*. It asks the hardware
 * layer one question — "is a printer reachable?" — via
 * `printerStatusSnapshot()`, and otherwise deals entirely in document
 * identity (`documentType` + `documentId`) and intent. It used to be
 * co-located with `usePrinterStatus` under `hooks/pos/`, which put
 * document dispatch inside a hardware hook inside a POS-scoped folder.
 *
 * ## Contract
 *
 * Callers MUST provide `documentType` + `documentId`; the document is
 * rendered server-side. The legacy HTML-string pipeline is gone. Pass an
 * intent so thermal documents route to thermal hardware and A4 documents
 * route to PDF.
 *
 * Failure is never silent: when dispatch fails the fallback dialog opens
 * and the operator chooses (retry / PDF / cancel / email / preview)
 * rather than the job vanishing.
 */

import { useCallback, useState } from "react";
import { printDocument } from "@/services/printing/PrintService";
import { printerStatusSnapshot } from "@/hooks/hardware/usePrinterStatus";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

import type {
  PrintIntent,
  PrinterStatus,
  PrintFallbackAction,
  PrintResult,
} from "@/services/printing/types";

export function usePrintWithFallback(options: { registerId?: string | null } = {}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  // Readiness is a tenant question (registry + workstation heartbeat), so
  // the snapshot must carry org/business/register context.
  const statusCtx = {
    organizationId: currentOrg?.id ?? null,
    businessId: currentBusiness?.id ?? null,
    registerId: options.registerId ?? null,
  };
  const [showFallbackDialog, setShowFallbackDialog] = useState(false);
  const [currentPrinterStatus, setCurrentPrinterStatus] =
    useState<PrinterStatus | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pending, setPending] = useState<
    | { intent: PrintIntent; documentType: string; documentId: string; filename: string }
    | null
  >(null);

  const printWithFallback = useCallback(
    async (req: {
      intent: PrintIntent;
      documentType: string;
      documentId: string;
      filename?: string;
    }): Promise<PrintResult> => {
      const filename = req.filename ?? `${req.documentType}-${Date.now()}`;
      setPending({ ...req, filename });
      const status = await printerStatusSnapshot(statusCtx);
      setCurrentPrinterStatus(status);
      const result = await printDocument({
        documentType: req.documentType,
        documentId: req.documentId,
        intent: req.intent,
      });
      if (!result.success) {
        setShowFallbackDialog(true);
        return { success: false, error: result.error, fallbackUsed: "none" };
      }
      return {
        success: true,
        fallbackUsed: result.transport === "thermal" ? "none" : "browser",
      };
    },
    [statusCtx.organizationId, statusCtx.businessId, statusCtx.registerId],
  );

  const handleFallbackAction = useCallback(
    async (action: PrintFallbackAction) => {
      if (!pending) {
        setShowFallbackDialog(false);
        return;
      }
      setIsProcessing(true);
      try {
        if (action === "pdf") {
          // Same pipeline, download disposition — the operator keeps a
          // PDF when hardware is unavailable.
          await printDocument({
            documentType: pending.documentType,
            documentId: pending.documentId,
            medium: "pdf",
            disposition: "download",
            filename: pending.filename,
          });
          setShowFallbackDialog(false);
        } else if (action === "retry") {
          const s = await printerStatusSnapshot(statusCtx);
          setCurrentPrinterStatus(s);
          if (s.available) {
            setShowFallbackDialog(false);
            await printDocument({
              documentType: pending.documentType,
              documentId: pending.documentId,
              intent: pending.intent,
            });
          }
        } else {
          // 'cancel' | 'email' | 'preview' — caller handles UI side effects.
          setShowFallbackDialog(false);
        }
      } finally {
        setIsProcessing(false);
      }
    },
    [pending, statusCtx.organizationId, statusCtx.businessId, statusCtx.registerId],
  );

  const closeFallbackDialog = useCallback(() => {
    setShowFallbackDialog(false);
  }, []);

  return {
    printWithFallback,
    showFallbackDialog,
    setShowFallbackDialog: closeFallbackDialog,
    currentPrinterStatus,
    handleFallbackAction,
    isProcessing,
    pendingHtml: null as string | null, // legacy field retained for back-compat
  };
}
