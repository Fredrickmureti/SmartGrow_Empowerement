/**
 * useLabelVerification — "walk the aisle and prove the labels are right".
 *
 * Printing a bin label is only half the lifecycle; a label that is stuck on
 * the wrong beam silently corrupts every put-away and pick that follows.
 * Verification closes the loop: the operator scans each printed label, the
 * scan resolves through `resolve_location_identity` (the single seam), and
 * the session records pass / unknown so the failures can be reprinted.
 */
import { useCallback, useMemo, useState } from "react";
import { useResolveLocationIdentity } from "./useResolveLocationIdentity";
import { useScanFeedback } from "@/features/warehouse/scanning/useScanFeedback";

export type VerifyOutcome = "verified" | "unknown" | "inactive";

export interface VerifyEntry {
  raw: string;
  outcome: VerifyOutcome;
  locationId: string | null;
  code: string | null;
  at: string;
}

export function useLabelVerification(warehouseId: string | null) {
  const { resolve } = useResolveLocationIdentity(warehouseId);
  const feedback = useScanFeedback();
  const [entries, setEntries] = useState<VerifyEntry[]>([]);

  const record = useCallback(
    async (raw: string): Promise<VerifyEntry> => {
      const result = await resolve(raw);
      let entry: VerifyEntry;
      if (result.status === "ok" && result.location) {
        entry = {
          raw,
          outcome: result.location.is_active ? "verified" : "inactive",
          locationId: result.location.location_id,
          code: result.location.code,
          at: new Date().toISOString(),
        };
      } else {
        entry = { raw, outcome: "unknown", locationId: null, code: null, at: new Date().toISOString() };
      }
      if (entry.outcome === "verified") feedback.success();
      else if (entry.outcome === "inactive") feedback.warn();
      else feedback.error();
      setEntries((prev) => [entry, ...prev.filter((e) => e.raw !== raw)].slice(0, 500));
      return entry;
    },
    [resolve, feedback],
  );

  const stats = useMemo(() => {
    const verified = entries.filter((e) => e.outcome === "verified").length;
    return { total: entries.length, verified, failed: entries.length - verified };
  }, [entries]);

  const reset = useCallback(() => setEntries([]), []);

  return { entries, stats, record, reset, Flash: feedback.Flash };
}
