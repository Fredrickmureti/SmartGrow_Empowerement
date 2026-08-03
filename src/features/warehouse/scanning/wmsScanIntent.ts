/**
 * WMS Scan Intent registry (Phase 2.1, ADR 0101).
 *
 * Operational WMS surfaces declare *what kind of thing they expect the
 * operator to scan next*. The registry sits on top of the platform
 * `scanRouter` and adds three things every WMS page needs:
 *
 *   1. A typed intent union so grep + guard tests can enforce that
 *      every WMS scan surface is opting into an intent (no ambient
 *      "receive whatever" scanners hiding in the tree).
 *   2. GS1 pre-parse (ADR 0071) applied uniformly, so the handler
 *      receives normalised `{ gtin, lot, serial, expiry, quantity }`
 *      regardless of whether the operator scanned a raw GTIN, a
 *      GS1-128 carton label, or a raw LPN barcode.
 *   3. A shared `reportUnexpected()` helper that routes a rejected
 *      scan to `scanFeedbackBus` as an error, so audio + haptic
 *      feedback stays consistent across every WMS page.
 *
 * The hook maps each WMS intent to the platform-level `ScanIntent`
 * used by scanRouter's conflict detector:
 *
 *   receiving.*  → inventory_receive
 *   count.*      → inventory_count
 *   everything   → identity   (LPN/bin/location/carton — code IS payload)
 *
 * This preserves the invariant that two WMS surfaces at the same
 * priority cannot silently step on each other (e.g. a receiving
 * screen and a count screen mounted together would conflict, which is
 * correct — the operator can't be doing both at once).
 */
import { useEffect, useRef } from "react";
import { scanRouter, type ScanIntent, type ScanWorkflow } from "@/services/pos/scanRouter";
import type { ScanEvent } from "@/services/pos/scanBus";
import { scanFeedbackBus } from "@/services/pos/scanFeedbackBus";
import { interpretScan, type Gs1ScanInterpretation } from "@/lib/gs1/useGs1Scanner";

/**
 * The operational scan intents recognised by WMS surfaces. Naming is
 * `<aggregate>.<what-is-being-scanned>` so future guard tests can pin
 * a surface (e.g. `PutawayQueue`) to a specific intent.
 */
export type WmsScanIntent =
  | "receiving.lpn"
  | "receiving.item"
  | "putaway.bin"
  | "putaway.lpn"
  | "pick.location"
  | "pick.item"
  | "pack.carton"
  | "load.lpn"
  | "count.location"
  | "count.item"
  | "qc.lpn"
  /** Returns audit Phase 5 — RMA dock capture scans the returned item. */
  | "returns.item"
  | "returns.lpn"
  /** Replenishment execution (ADR 0106) — source bin, LPN, then pick face. */
  | "replen.source_location"
  | "replen.lpn"
  | "replen.item"
  | "replen.destination";

/** Normalised payload delivered to the surface's onScan handler. */
export interface WmsScanPayload {
  /** The intent that was active when this scan landed. */
  intent: WmsScanIntent;
  /** Raw code as received by the router (post scanBus trim). */
  raw: string;
  /**
   * Code intended for downstream product/lpn/bin resolution. For a
   * GS1 payload this is the GTIN; otherwise the raw code.
   */
  resolveCode: string;
  /** True when the scan parsed as a GS1 payload. */
  isGs1: boolean;
  /** GS1 pre-parse output — undefined fields when not present in the scan. */
  gs1: Gs1ScanInterpretation["normalized"];
  /** Original router event, for advanced consumers (telemetry, replay). */
  event: ScanEvent;
}

function intentToWorkflow(intent: WmsScanIntent): {
  workflow: ScanWorkflow;
  scanIntent: ScanIntent;
} {
  if (intent.startsWith("receiving.")) return { workflow: "receive", scanIntent: "inventory_receive" };
  if (intent.startsWith("count."))     return { workflow: "count",   scanIntent: "inventory_count" };
  // putaway / pick / pack / load / qc — code IS payload; no repeat semantics.
  return { workflow: "identity", scanIntent: "identity" };
}

export interface UseWmsScanIntentOptions {
  /** Intent this surface accepts while mounted. */
  intent: WmsScanIntent;
  /**
   * Router priority. Defaults to 20 — above focused BarcodeInputField
   * (10), below any explicit modal picker (30+). Modal pickers that
   * want to steal focus should pass 30.
   */
  priority?: number;
  /** Fired for every accepted scan, after GS1 pre-parse. */
  onScan: (payload: WmsScanPayload) => void;
  /**
   * Optional label for debug inspection. Defaults to the intent
   * string.
   */
  label?: string;
  /**
   * Repeat-scan flag. Receiving and counting workflows scan the same
   * item multiple times; putaway/pick/pack do not.
   */
  allowRepeats?: boolean;
  /** Disable the registration temporarily without unmounting. */
  enabled?: boolean;
}

/**
 * Mount a WMS scan intent for the lifetime of the caller component.
 * Returns a `reportUnexpected(reason, detail)` helper so the caller
 * can reject a scan that doesn't fit the current sub-state (e.g. a
 * `receiving.item` scanned before an LPN has been opened).
 */
export function useWmsScanIntent(opts: UseWmsScanIntentOptions) {
  const { intent, priority = 20, onScan, label, allowRepeats, enabled = true } = opts;
  // Keep the latest onScan without re-registering the router entry.
  const handlerRef = useRef(onScan);
  handlerRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    const { workflow, scanIntent } = intentToWorkflow(intent);
    const unregister = scanRouter.register({
      id: `wms:${intent}:${Math.random().toString(36).slice(2, 8)}`,
      priority,
      workflow,
      intent: scanIntent,
      allowRepeats: allowRepeats ?? (intent.startsWith("receiving.") || intent.startsWith("count.")),
      label: label ?? `wms:${intent}`,
      onScan: (event) => {
        const parsed = interpretScan(event.code || event.raw);
        try {
          handlerRef.current({
            intent,
            raw: event.raw,
            resolveCode: parsed.resolveCode,
            isGs1: parsed.isGs1,
            gs1: parsed.normalized,
            event,
          });
        } catch (err) {
          console.error(`[useWmsScanIntent:${intent}] handler error`, err);
          scanFeedbackBus.emit({
            kind: "error",
            raw: event.raw,
            detail: err instanceof Error ? err.message : "Scan handler failed",
            source: "field",
            workflow,
          });
        }
      },
    });
    return unregister;
  }, [intent, priority, allowRepeats, label, enabled]);

  return {
    /**
     * Route a rejected scan to `scanFeedbackBus.error` so the shared
     * ghost ticker + audio/haptic layer surfaces the error uniformly.
     */
    reportUnexpected(raw: string, reason: string) {
      const { workflow } = intentToWorkflow(intent);
      scanFeedbackBus.emit({
        kind: "error",
        raw,
        detail: reason,
        source: "field",
        workflow,
      });
    },
  };
}
