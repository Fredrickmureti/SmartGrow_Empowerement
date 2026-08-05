/**
 * ScanFeedbackTonePlayer — turns every `scanFeedbackBus` verdict into audio.
 *
 * Mounted once in `AuthenticatedShell`, so any module that already emits a
 * scan verdict (product identifiers, barcode fields, sales/invoice line
 * scanning, warehouse intents, POS cart) gets the same operator beep with
 * zero extra wiring. Muting is honoured through `feedbackTones`.
 */
import { useEffect } from "react";
import { scanFeedbackBus } from "@/services/pos/scanFeedbackBus";
import { toneForAck } from "@/services/scanner/feedbackTones";
import { beepForScan } from "@/services/scanner/scanBeep";

export function ScanFeedbackTonePlayer() {
  useEffect(
    () =>
      scanFeedbackBus.on((f) => {
        // "pending" is an in-flight placeholder — the real verdict follows.
        if (f.kind === "pending") return;
        beepForScan(f.raw, toneForAck(f.kind));
      }),
    [],
  );
  return null;
}
