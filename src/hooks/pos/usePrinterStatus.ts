/**
 * usePrinterStatus — printer reachability hook backed by the unified
 * hardware client.
 *
 * Audit Wave 10 (P0 #6 / P1 #8). Replaces the legacy `printService`
 * shim. The hook now reads `hardwareClient.devices.getStatuses()`
 * directly and projects the receipt/kitchen/label printer rows onto
 * the UI-facing `PrinterStatus` shape. No more 10s `setInterval` of a
 * hard-coded `networkPrinterConnected: false`.
 *
 * Polling is opt-in. Default is "on" inside Electron (where
 * `DeviceManager` already pings devices, so the poll is cheap) and
 * "off" in pure browser preview to avoid waking the WebUSB stack on
 * every render.
 *
 * `usePrintWithFallback` is kept as a thin compatibility wrapper that
 * routes through `printClient`. The legacy `smartPrint` HTML pipeline
 * is gone; pass `documentType` + `documentId` to render server-side.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { hardwareClient } from "@/services/hardware/HardwareClient";
import { printClient } from "@/services/printing/PrintClient";
import type { PrintIntent } from "@/services/printing/types";
import {
  printPdfInPage,
  generateDocumentPdf,
} from "@/services/printing/pdfUtils";
import type {
  PrinterStatus,
  PrintFallbackAction,
  PrintResult,
} from "@/services/printing/types";

export type {
  PrinterStatus,
  PrintFallbackAction,
  PrintResult,
} from "@/services/printing/types";

interface UsePrinterStatusOptions {
  /** Enable automatic polling. Default: on in Electron, off in browser. */
  enableMonitoring?: boolean;
  /** Polling interval in ms (default: 10_000). */
  monitoringInterval?: number;
}

function isElectronRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(
      (window as unknown as { pos?: { isElectron?: boolean } }).pos?.isElectron,
    )
  );
}

async function snapshot(): Promise<PrinterStatus> {
  let receipt = false;
  let kitchen = false;
  let label = false;
  try {
    const statuses = await hardwareClient.devices.getStatuses();
    for (const s of statuses) {
      if (!s.connected) continue;
      if (s.role === "receipt_printer") receipt = true;
      else if (s.role === "kitchen_printer") kitchen = true;
      else if (s.role === "label_printer") label = true;
    }
  } catch {
    /* offline → leave all flags false; UI shows the warning */
  }
  const count = [receipt, kitchen, label].filter(Boolean).length;
  return {
    available: count > 0,
    printerCount: count,
    defaultPrinter: receipt
      ? "receipt_printer"
      : kitchen
      ? "kitchen_printer"
      : label
      ? "label_printer"
      : null,
    lastChecked: new Date(),
    networkPrinterConnected: receipt,
    networkPrinter: null,
  };
}

export function statusMessageFor(s: PrinterStatus | null): string {
  if (!s) return "Checking…";
  if (!s.available) return "No printer connected";
  if (s.networkPrinterConnected) {
    return s.printerCount > 1
      ? `Receipt printer + ${s.printerCount - 1} other(s)`
      : "Receipt printer connected";
  }
  return `${s.printerCount} printer(s) available`;
}

export function usePrinterStatus(options: UsePrinterStatusOptions = {}) {
  const {
    enableMonitoring = isElectronRuntime(),
    monitoringInterval = 10_000,
  } = options;

  const [printerStatus, setPrinterStatus] = useState<PrinterStatus | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const timerRef = useRef<number | null>(null);

  const checkStatus = useCallback(async (): Promise<PrinterStatus> => {
    setIsChecking(true);
    try {
      const next = await snapshot();
      setPrinterStatus(next);
      return next;
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await snapshot();
      if (!cancelled) setPrinterStatus(s);
    })();

    if (enableMonitoring && typeof window !== "undefined") {
      timerRef.current = window.setInterval(async () => {
        const s = await snapshot();
        if (!cancelled) setPrinterStatus(s);
      }, monitoringInterval);
    }

    return () => {
      cancelled = true;
      if (timerRef.current !== null && typeof window !== "undefined") {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enableMonitoring, monitoringInterval]);

  return {
    printerStatus,
    isChecking,
    checkStatus,
    isAvailable: printerStatus?.available ?? false,
    printerCount: printerStatus?.printerCount ?? 0,
    defaultPrinter: printerStatus?.defaultPrinter ?? null,
    statusMessage: statusMessageFor(printerStatus),
    shouldWarn: printerStatus ? !printerStatus.available : false,
  };
}

/**
 * usePrintWithFallback — thin wrapper around `printClient` that shows
 * the fallback dialog when the printer is unavailable.
 *
 * Callers MUST provide `documentType` + `documentId`. The HTML-string
 * pipeline that the old shim accepted is gone (it depended on
 * `pos.print.html`, which the audit removed). Pass an intent so the
 * client routes thermal docs to thermal hardware and A4 docs to PDF.
 */
export function usePrintWithFallback() {
  const [showFallbackDialog, setShowFallbackDialog] = useState(false);
  const [currentPrinterStatus, setCurrentPrinterStatus] = useState<PrinterStatus | null>(null);
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
      const status = await snapshot();
      setCurrentPrinterStatus(status);
      const result = await printClient.print(req);
      if (!result.success) {
        setShowFallbackDialog(true);
        return { success: false, error: result.error, fallbackUsed: "none" };
      }
      return {
        success: true,
        fallbackUsed: result.transport === "thermal" ? "none" : "browser",
      };
    },
    [],
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
          const blob = await generateDocumentPdf(pending.documentType, pending.documentId);
          await printPdfInPage(blob);
          setShowFallbackDialog(false);
        } else if (action === "retry") {
          const s = await snapshot();
          setCurrentPrinterStatus(s);
          if (s.available) {
            setShowFallbackDialog(false);
            await printClient.print(pending);
          }
        } else {
          // 'cancel' | 'email' | 'preview' — caller handles UI side effects.
          setShowFallbackDialog(false);
        }
      } finally {
        setIsProcessing(false);
      }
    },
    [pending],
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
