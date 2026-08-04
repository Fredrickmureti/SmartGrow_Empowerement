/**
 * usePrinterStatus — "can a printer actually service a job right now?".
 *
 * ## Scope
 *
 * This hook answers a *readiness* question and delegates the answer to the
 * single readiness service (`services/hardware/readiness.ts`), which asks
 * the platform — registry (`resolve_device`) plus workstation heartbeat —
 * rather than the local renderer transport.
 *
 * It previously read `hardwareClient.devices.getStatuses()` directly. That
 * is a *local runtime* probe: a printer owned by another machine's IoT
 * agent and reached over the `edge_jobs` relay is never "connected"
 * locally, so POS reported "No printer connected" while Invoice/Label
 * printing (which never consulted the probe) worked. `getStatuses()` is now
 * reserved for diagnostics.
 *
 * It never renders a document and never dispatches a job — document
 * dispatch lives in `hooks/printing/usePrintWithFallback`.
 *
 * Hardware is a platform concern consumed identically by POS, Inventory,
 * Warehouse, HR and Manufacturing, so it does not belong under `*/pos/`
 * (see `hardware-not-pos-scoped.test.ts`).
 *
 * ## Polling
 *
 * Opt-in via `enableMonitoring`; the readiness read is a cheap pair of
 * indexed queries, so polling is safe in the browser too.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveIntentReadiness } from "@/services/hardware/readiness";
import type { IntentReadiness } from "@/services/hardware/readiness";
import type { PrinterStatus } from "@/services/printing/types";

export type {
  PrinterStatus,
  PrintFallbackAction,
  PrintResult,
} from "@/services/printing/types";

export interface PrinterStatusContext {
  organizationId?: string | null;
  businessId?: string | null;
  /** Register scope, when the caller owns a POS register. */
  registerId?: string | null;
}

interface UsePrinterStatusOptions extends PrinterStatusContext {
  /** Enable automatic polling. Default: off. */
  enableMonitoring?: boolean;
  /** Polling interval in ms (default: 15_000). */
  monitoringInterval?: number;
}

const PRINTER_ROLES = [
  "receipt_printer",
  "kitchen_printer",
  "label_printer",
] as const;

/**
 * One-shot printer readiness read.
 *
 * Exported so non-React callers (and the printing layer's fallback flow)
 * can take a reading without mounting a hook. Pass tenant context so the
 * registry can be consulted; without it the read degrades to the local
 * runtime only.
 */
export async function printerStatusSnapshot(
  ctx: PrinterStatusContext = {},
): Promise<PrinterStatus> {
  const scope = ctx.registerId
    ? ({ kind: "register", id: ctx.registerId } as const)
    : undefined;

  const results = await Promise.all(
    PRINTER_ROLES.map((role) =>
      resolveIntentReadiness({
        organizationId: ctx.organizationId ?? null,
        intentOrRole: role,
        businessId: ctx.businessId ?? null,
        scope,
      }).catch(
        (): IntentReadiness => ({
          state: "unknown",
          ready: false,
          role,
          device: null,
          message: "Could not check printer availability",
          checkedAt: new Date(),
        }),
      ),
    ),
  );

  const byRole = new Map(results.map((r) => [r.role, r]));
  const receipt = byRole.get("receipt_printer")?.ready ?? false;
  const kitchen = byRole.get("kitchen_printer")?.ready ?? false;
  const label = byRole.get("label_printer")?.ready ?? false;
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
    /** Richest per-role reason, used for operator-facing copy. */
    readiness: results,
  } as PrinterStatus;
}

/**
 * Operator-facing status line. Prefers the specific readiness reason over
 * the old flat "No printer connected".
 */
export function statusMessageFor(s: PrinterStatus | null): string {
  if (!s) return "Checking…";
  const readiness = (s as PrinterStatus & { readiness?: IntentReadiness[] }).readiness;
  if (!s.available) {
    const receipt = readiness?.find((r) => r.role === "receipt_printer");
    if (receipt && receipt.state !== "unknown") return receipt.message;
    const anyReason = readiness?.find((r) => r.state !== "unknown");
    return anyReason?.message ?? "No printer assigned";
  }
  if (s.networkPrinterConnected) {
    return s.printerCount > 1
      ? `Receipt printer + ${s.printerCount - 1} other(s)`
      : "Receipt printer ready";
  }
  return `${s.printerCount} printer(s) available`;
}


export function usePrinterStatus(options: UsePrinterStatusOptions = {}) {
  const {
    enableMonitoring = false,
    monitoringInterval = 15_000,
    organizationId = null,
    businessId = null,
    registerId = null,
  } = options;

  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = organizationId ?? currentOrg?.id ?? null;
  const bizId = businessId ?? currentBusiness?.id ?? null;

  const [printerStatus, setPrinterStatus] = useState<PrinterStatus | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const timerRef = useRef<number | null>(null);

  const checkStatus = useCallback(async (): Promise<PrinterStatus> => {
    setIsChecking(true);
    try {
      const next = await printerStatusSnapshot({
        organizationId: orgId,
        businessId: bizId,
        registerId,
      });
      setPrinterStatus(next);
      return next;
    } finally {
      setIsChecking(false);
    }
  }, [orgId, bizId, registerId]);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const s = await printerStatusSnapshot({
        organizationId: orgId,
        businessId: bizId,
        registerId,
      });
      if (!cancelled) setPrinterStatus(s);
    };
    void read();

    if (enableMonitoring && typeof window !== "undefined") {
      timerRef.current = window.setInterval(() => void read(), monitoringInterval);
    }

    return () => {
      cancelled = true;
      if (timerRef.current !== null && typeof window !== "undefined") {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enableMonitoring, monitoringInterval, orgId, bizId, registerId]);


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
