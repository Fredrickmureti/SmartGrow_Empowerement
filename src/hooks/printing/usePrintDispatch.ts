/**
 * usePrintDispatch — the ONE acknowledgement surface for document prints.
 *
 * Phase 5.2 of the printing latency redesign. Before this hook, every
 * document surface awaited `printDocumentIntent` / `printSourceDocumentIntent`
 * — i.e. it awaited claim + render + device resolve + printer socket —
 * before it was allowed to tell the operator anything. That is why a print
 * click felt like 5–18 seconds of dead UI.
 *
 * A print is two moments, and this hook exposes exactly those:
 *
 *   1. QUEUED — the document record exists and one `print_jobs` row per
 *      target is committed. Recoverable by the sweeper even if the tab
 *      closes. The operator is told here, and released here.
 *   2. TERMINAL — the background drain finished (printed, or failed with a
 *      reason). A second toast reports it; nothing blocks on it.
 *
 * Surfaces therefore never await a printer. They call `dispatch(...)` and
 * return. `PrintService` remains the only pipeline: this hook adds no
 * render, no device resolution and no ledger write of its own.
 */
import { useCallback, useRef, useState } from "react";

import { useToast } from "@/hooks/use-toast";
import {
  startPrintDocumentIntent,
  startPrintSourceDocumentIntent,
  type IntentAcknowledgement,
} from "@/services/printing/PrintService";
import {
  printOutcomeToast,
  printQueuedToast,
} from "@/services/printing/printOutcomeToast";
import type { EnsureDocumentRecordInput } from "@/services/documents/ensureDocumentRecord";

type SourceInput = EnsureDocumentRecordInput & {
  scenario?: string;
  triggeredSource?: "business_event" | "manual" | "reprint" | "api";
};

type RecordInput = {
  documentRecordId: string;
  scenario?: string;
  triggeredSource?: "business_event" | "manual" | "reprint" | "api";
  organizationId?: string | null;
};

export interface PrintDispatchOptions {
  /** Operator-facing document name, e.g. `Invoice INV-1042`. */
  label: string;
  /** Suppress the terminal toast (a surface that renders its own status pill). */
  silentTerminal?: boolean;
}

export interface PrintDispatchResult extends IntentAcknowledgement {}

export function usePrintDispatch() {
  const { toast } = useToast();
  // `queueing` covers moment (1) only — the durable enqueue. It is the only
  // spinner an operator should ever see for a print.
  const [queueing, setQueueing] = useState(false);
  const inFlight = useRef(0);

  const run = useCallback(
    async (
      start: () => Promise<IntentAcknowledgement>,
      options: PrintDispatchOptions,
    ): Promise<PrintDispatchResult> => {
      inFlight.current += 1;
      setQueueing(true);
      let ack: IntentAcknowledgement;
      try {
        ack = await start();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        toast(printOutcomeToast({ success: false, error }, options.label));
        throw err;
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) setQueueing(false);
      }

      if (!ack.queued) {
        toast(printOutcomeToast({ success: false, error: ack.error }, options.label));
        return ack;
      }

      toast(printQueuedToast(options.label, ack.targetCount));

      // Terminal outcome, off the operator's clock. `completion` never
      // rejects, so this can never surface as an unhandled rejection.
      void ack.completion.then((result) => {
        if (options.silentTerminal) return;
        if (result.success) return; // already acknowledged as queued
        toast(
          printOutcomeToast(
            { success: false, error: result.error, needsDevice: result.needsDevice },
            options.label,
          ),
        );
      });

      return ack;
    },
    [toast],
  );

  /** Print a `(kind, source document)` pair — the entry most surfaces want. */
  const dispatchSource = useCallback(
    (input: SourceInput, options: PrintDispatchOptions) =>
      run(() => startPrintSourceDocumentIntent(input), options),
    [run],
  );

  /** Print an already-materialized Document Record (reprints, archives). */
  const dispatchRecord = useCallback(
    (input: RecordInput, options: PrintDispatchOptions) =>
      run(() => startPrintDocumentIntent(input), options),
    [run],
  );

  return { dispatchSource, dispatchRecord, queueing };
}

export default usePrintDispatch;
