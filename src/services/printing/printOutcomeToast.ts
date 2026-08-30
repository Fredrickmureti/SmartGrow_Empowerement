/**
 * printOutcomeToast — one honest description of what actually happened.
 *
 * Every document surface used to toast "Print dispatched … queued to N
 * target(s)" the moment `printDocumentIntent` returned, without reading
 * `result.success`. The ledger recorded `failed` while the operator saw
 * green. This helper is the single translation from a print result to
 * operator-facing copy, so no surface can be optimistic on its own.
 */
export interface PrintIntentOutcome {
  success: boolean;
  error?: string;
  target_count?: number;
  copies?: number;
}

export interface OutcomeToast {
  title: string;
  description: string;
  variant?: 'destructive';
}

/** Normalise a dispatch error into operator-facing copy. */
function humanise(error: string | undefined): string {
  if (!error) return 'The printer did not accept the job.';
  return error.trim() || 'The printer did not accept the job.';
}

export function printOutcomeToast(result: PrintIntentOutcome, label: string): OutcomeToast {
  if (!result.success) {
    return {
      title: 'Print failed',
      description: `${label} did not print: ${humanise(result.error)}`,
      variant: 'destructive',
    };
  }
  const targets = result.target_count ?? 0;
  return {
    title: 'Print dispatched',
    description: `${label} sent to ${targets} target(s).`,
  };
}

/**
 * Acknowledgement copy for the non-blocking path (Phase 5).
 *
 * The claim here is deliberately narrower than "dispatched": at this point
 * the routing plan and its ledger rows are durable and recoverable, but no
 * byte has reached a printer yet. Saying "queued" is the honest statement,
 * and it is the one enterprise spools make — SAP's output request, D365's
 * document routing entry. A failure later arrives as its own toast.
 */
export function printQueuedToast(label: string, targetCount: number): OutcomeToast {
  return {
    title: 'Print queued',
    description:
      targetCount > 0
        ? `${label} queued to ${targetCount} target(s).`
        : `${label} queued.`,
  };
}
