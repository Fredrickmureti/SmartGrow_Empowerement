/**
 * scanFeedbackBus — UI-facing pub/sub for the ghost ticker.
 */

export interface ScanFeedback {
  kind: "ok" | "weighted" | "unknown" | "pending" | "error";
  raw: string;
  detail?: string;
  /**
   * Which UI produced the feedback.
   * - "terminal" (default): POS cart-side verdict. Mirrored back to the
   *   paired phone as a green/red beep via `usePOSScannerChannel`.
   * - "field": a `<BarcodeInputField>` ack for onboarding/inventory forms.
   *   POS register channels MUST NOT mirror these — the phone is paired
   *   to the register, not to the form, and would beep for unrelated scans.
   */
  source?: "terminal" | "field";
  /**
   * S3 — workflow chip mirrored to the phone via the ACK broadcast.
   * Tagged by `<BarcodeInputField>` (always "identity") and POS cart
   * verdicts (always "quantity"). Optional so old call sites stay
   * back-compat.
   */
  workflow?: "identity" | "quantity" | "count" | "receive";
  /** Human-readable field label so the phone shows "Count · Bin A12". */
  fieldLabel?: string;
}

type Listener = (f: ScanFeedback) => void;

const listeners = new Set<Listener>();

export const scanFeedbackBus = {
  on(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  emit(feedback: ScanFeedback): void {
    for (const fn of Array.from(listeners)) {
      try {
        fn(feedback);
      } catch (err) {
        console.error("[scanFeedbackBus] listener error", err);
      }
    }
  },
};
