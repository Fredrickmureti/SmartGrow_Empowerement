/**
 * scanBeep — the single entry point for "a scan just happened, make a noise".
 *
 * Why this exists: audible feedback used to be produced in exactly two
 * places (`LocalScanOverlay` for the device camera, `MobileScannerPage` for
 * the paired-phone cockpit). Every other scan surface — product creation,
 * identifier editing, sales/invoice line scanning, warehouse intents — only
 * emitted a `scanFeedbackBus` verdict, which nothing turned into sound. The
 * operator therefore got a beep on some screens and silence on others.
 *
 * Now every verdict beeps (see `<ScanFeedbackTonePlayer>`), and this helper
 * keeps a single scan from beeping twice when both the viewfinder and the
 * downstream verdict fire for the same code.
 *
 * Escalation rule: within the dedupe window a *worse* verdict may still
 * play (ok → duplicate/invalid), because "it scanned" followed by "…but it
 * is a duplicate" must be audible. The reverse is suppressed.
 */
import { feedbackTones, type ToneName } from "./feedbackTones";

const WINDOW_MS = 700;

const RANK: Record<ToneName, number> = {
  ok: 0,
  duplicate: 1,
  invalid: 2,
  disconnect: 3,
};

let lastKey = "";
let lastTone: ToneName | null = null;
let lastAt = 0;

/**
 * Play the tone for a scan outcome, deduped per code.
 * @param code the scanned payload (used as the dedupe key)
 */
export function beepForScan(code: string, tone: ToneName): void {
  const key = (code || "").trim();
  const now = Date.now();
  const fresh = now - lastAt > WINDOW_MS || key !== lastKey;
  if (!fresh && lastTone !== null && RANK[tone] <= RANK[lastTone]) return;
  lastKey = key;
  lastTone = tone;
  lastAt = now;
  feedbackTones.play(tone);
}

/** Test helper. */
export function _resetScanBeep(): void {
  lastKey = "";
  lastTone = null;
  lastAt = 0;
}
