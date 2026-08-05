/**
 * useScanHistory — the operator's short-term memory (Phase 4.4).
 *
 * Every WMS scan verdict already flows on `scanFeedbackBus`. This hook is
 * a bounded view over that stream: the last few events with the verdict
 * the operator needs to spot a mis-scan. It stores nothing, subscribes
 * once, and never touches the network.
 */
import { useEffect, useRef, useState } from "react";
import { scanFeedbackBus } from "@/services/pos/scanFeedbackBus";
import { classifyFeedback, type ScanVerdict } from "./scanGuidance";

export interface ScanHistoryEntry {
  /** Monotonic id so a list key never collides on identical codes. */
  key: number;
  raw: string;
  detail?: string;
  verdict: ScanVerdict;
  at: number;
}

const DEFAULT_LIMIT = 5;

export function useScanHistory(limit = DEFAULT_LIMIT): ScanHistoryEntry[] {
  const [entries, setEntries] = useState<ScanHistoryEntry[]>([]);
  const seq = useRef(0);

  useEffect(
    () =>
      scanFeedbackBus.on((f) => {
        // "pending" is an in-flight marker, not an outcome.
        if (f.kind === "pending") return;
        const entry: ScanHistoryEntry = {
          key: ++seq.current,
          raw: f.raw,
          detail: f.detail,
          verdict: classifyFeedback(f.kind, f.detail),
          at: Date.now(),
        };
        setEntries((prev) => [entry, ...prev].slice(0, limit));
      }),
    [limit],
  );

  return entries;
}
