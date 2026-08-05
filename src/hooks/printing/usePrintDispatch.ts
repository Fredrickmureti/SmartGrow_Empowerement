/**
 * usePrintDispatch — React binding for the non-blocking print path.
 *
 * Phase 5.2 of the printing latency redesign. The behaviour lives in
 * `services/printing/acknowledge` so plain service modules and React
 * surfaces share one implementation; this hook only supplies the toast
 * sink and a `queueing` flag for the button spinner.
 *
 * `queueing` covers the durable enqueue only — the one moment an operator
 * should ever wait for. Render, device resolution and the printer socket
 * happen after the hook has already returned.
 */
import { useCallback, useRef, useState } from "react";

import { useToast } from "@/hooks/use-toast";
import {
  acknowledgeRecordPrint,
  acknowledgeSourcePrint,
  type AcknowledgeOptions,
} from "@/services/printing/acknowledge";
import type { IntentAcknowledgement } from "@/services/printing/PrintService";
import { printOutcomeToast } from "@/services/printing/printOutcomeToast";
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

export type PrintDispatchOptions = AcknowledgeOptions;
export type PrintDispatchResult = IntentAcknowledgement;

export function usePrintDispatch() {
  const { toast } = useToast();
  const [queueing, setQueueing] = useState(false);
  const inFlight = useRef(0);

  const run = useCallback(
    async (
      start: () => Promise<IntentAcknowledgement>,
      options: PrintDispatchOptions,
    ): Promise<IntentAcknowledgement> => {
      inFlight.current += 1;
      setQueueing(true);
      try {
        return await start();
      } catch (err) {
        // Snapshot / materialize failures never reach the ledger, so they
        // have no row to report through — toast them here.
        const error = err instanceof Error ? err.message : String(err);
        toast(printOutcomeToast({ success: false, error }, options.label));
        throw err;
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0) setQueueing(false);
      }
    },
    [toast],
  );

  /** Print a `(kind, source document)` pair — the entry most surfaces want. */
  const dispatchSource = useCallback(
    (input: SourceInput, options: PrintDispatchOptions) =>
      run(() => acknowledgeSourcePrint(input, toast, options), options),
    [run, toast],
  );

  /** Print an already-materialized Document Record (reprints, archives). */
  const dispatchRecord = useCallback(
    (input: RecordInput, options: PrintDispatchOptions) =>
      run(() => acknowledgeRecordPrint(input, toast, options), options),
    [run, toast],
  );

  return { dispatchSource, dispatchRecord, queueing };
}

export default usePrintDispatch;
