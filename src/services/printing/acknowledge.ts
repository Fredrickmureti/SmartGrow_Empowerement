/**
 * printing/acknowledge — the ONE place a print is acknowledged to a human.
 *
 * Phase 5 of the printing latency redesign. Every document surface used to
 * write this by hand:
 *
 *     const result = await printDocumentIntent({ documentRecordId });
 *     toast(printOutcomeToast(result, label));
 *
 * which awaited claim → render → device resolve → printer socket → ledger
 * close before the operator was told anything. That await is the reason a
 * print click cost 5–18 seconds of frozen UI on every surface in the ERP.
 *
 * The functions here replace that pattern with the two-moment contract:
 * the caller awaits only the durable enqueue, is acknowledged there, and a
 * terminal failure (if any) arrives later as its own toast. No surface
 * renders, resolves a device, or writes the ledger itself — this module
 * only calls `PrintService` and formats copy via `printOutcomeToast`.
 *
 * It takes the toast function as an argument rather than importing a hook,
 * so plain service modules (`dispatchGoodsReceipt`, `dispatchHrLetter`, …)
 * and React surfaces share exactly one implementation.
 */
import {
  startPrintDocumentIntent,
  startPrintSourceDocumentIntent,
  type IntentAcknowledgement,
} from './PrintService';
import { printOutcomeToast, printQueuedToast, type OutcomeToast } from './printOutcomeToast';
import type { EnsureDocumentRecordInput } from '@/services/documents/ensureDocumentRecord';

export type PrintToastFn = (toast: OutcomeToast) => void;

export interface AcknowledgeOptions {
  /** Operator-facing document name, e.g. `Invoice INV-1042`. */
  label: string;
  /** Surface renders its own live status; suppress the terminal toast. */
  silentTerminal?: boolean;
}

/**
 * Acknowledge the enqueue now, report a terminal failure later.
 *
 * Success is *not* re-toasted: the operator was already told the print was
 * queued, and a second "it worked" toast for every copy is noise. A failure
 * always surfaces, because a print that silently died is the one outcome an
 * operator must never have to discover from the paper tray.
 */
export function acknowledge(
  ack: IntentAcknowledgement,
  toast: PrintToastFn,
  options: AcknowledgeOptions,
): IntentAcknowledgement {
  if (!ack.queued) {
    toast(printOutcomeToast({ success: false, error: ack.error }, options.label));
    return ack;
  }

  toast(printQueuedToast(options.label, ack.targetCount));

  void ack.completion.then((result) => {
    if (options.silentTerminal || result.success) return;
    toast(
      printOutcomeToast(
        { success: false, error: result.error, needsDevice: result.needsDevice },
        options.label,
      ),
    );
  });

  return ack;
}

/** Queue a print for an already-materialized Document Record, and acknowledge it. */
export async function acknowledgeRecordPrint(
  input: {
    documentRecordId: string;
    scenario?: string;
    triggeredSource?: 'business_event' | 'manual' | 'reprint' | 'api';
    organizationId?: string | null;
  },
  toast: PrintToastFn,
  options: AcknowledgeOptions,
): Promise<IntentAcknowledgement> {
  return acknowledge(await startPrintDocumentIntent(input), toast, options);
}

/** Queue a print for a `(kind, source document)` pair, and acknowledge it. */
export async function acknowledgeSourcePrint(
  input: EnsureDocumentRecordInput & {
    scenario?: string;
    triggeredSource?: 'business_event' | 'manual' | 'reprint' | 'api';
  },
  toast: PrintToastFn,
  options: AcknowledgeOptions,
): Promise<IntentAcknowledgement> {
  return acknowledge(await startPrintSourceDocumentIntent(input), toast, options);
}
