/**
 * usePrinterStatus — "is a printer reachable right now?", nothing else.
 *
 * ## Scope
 *
 * This hook answers a *hardware* question. It reads
 * `hardwareClient.devices.getStatuses()` and projects the receipt /
 * kitchen / label printer rows onto the UI-facing `PrinterStatus` shape.
 * It never renders a document, never dispatches a job, and never imports
 * the print client.
 *
 * It previously lived at `hooks/pos/usePrinterStatus.ts` alongside
 * `usePrintWithFallback`, which conflated two concerns:
 *
 *   - device reachability  → hardware layer (this file)
 *   - document dispatch    → printing layer (`hooks/printing/usePrintWithFallback`)
 *
 * Hardware is a platform concern consumed identically by POS, Inventory,
 * Warehouse, HR and Manufacturing, so it does not belong under `*/pos/`
 * (see `hardware-not-pos-scoped.test.ts`).
 *
 * ## Polling
 *
 * Opt-in. Default is "on" inside Electron — where `DeviceManager` already
 * pings devices, so the poll reads a warm cache — and "off" in browser
 * preview, to avoid waking the WebUSB stack on every render.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { hardwareClient } from "@/services/hardware/HardwareClient";
import type { PrinterStatus } from "@/services/printing/types";

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

/**
 * One-shot printer reachability read.
 *
 * Exported so non-React callers (and the printing layer's fallback flow)
 * can take a status reading without mounting a hook. A transport failure
 * is not an error here: an unreachable agent is indistinguishable from
 * "no printers", and both should surface as the same operator warning.
 */
export async function printerStatusSnapshot(): Promise<PrinterStatus> {
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
      const next = await printerStatusSnapshot();
      setPrinterStatus(next);
      return next;
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await printerStatusSnapshot();
      if (!cancelled) setPrinterStatus(s);
    })();

    if (enableMonitoring && typeof window !== "undefined") {
      timerRef.current = window.setInterval(async () => {
        const s = await printerStatusSnapshot();
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
