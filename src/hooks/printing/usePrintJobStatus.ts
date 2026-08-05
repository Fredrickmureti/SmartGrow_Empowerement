/**
 * usePrintJobStatus — follow a set of `print_jobs` rows in real time.
 *
 * Phase 2 of the POS printing latency redesign: the cashier is released
 * the moment the ledger row exists, so the UI can no longer learn the
 * outcome from the awaited call. It learns it from the ledger instead —
 * exactly the same rows the recovery sweeper and the audit trail use, so
 * a background dispatch, a sweeper retry and a reprint all report through
 * one channel.
 *
 * The hook subscribes to the rows by id and also does one initial read,
 * so a job that settled before the subscription attached is not missed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type PrintJobStatus =
  | "queued"
  | "processing"
  | "sent"
  | "acked"
  | "failed"
  | "abandoned"
  | "dead_letter";

/** Collapsed, cashier-facing view of N copies of one print. */
export type PrintJobPhase = "idle" | "queued" | "sent" | "printed" | "failed";

export interface PrintJobStatusResult {
  phase: PrintJobPhase;
  error: string | null;
  statuses: Record<string, PrintJobStatus>;
}

const TERMINAL_OK: PrintJobStatus[] = ["acked"];
const TERMINAL_BAD: PrintJobStatus[] = ["failed", "abandoned", "dead_letter"];

function collapse(statuses: Record<string, PrintJobStatus>): PrintJobPhase {
  const values = Object.values(statuses);
  if (values.length === 0) return "idle";
  if (values.some((s) => TERMINAL_BAD.includes(s))) return "failed";
  if (values.every((s) => TERMINAL_OK.includes(s))) return "printed";
  if (values.some((s) => s === "sent" || s === "processing")) return "sent";
  return "queued";
}

export function usePrintJobStatus(jobIds: string[]): PrintJobStatusResult {
  const key = useMemo(() => [...jobIds].sort().join(","), [jobIds]);
  const [statuses, setStatuses] = useState<Record<string, PrintJobStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(key);

  useEffect(() => {
    keyRef.current = key;
    const ids = key ? key.split(",") : [];
    setStatuses({});
    setError(null);
    if (ids.length === 0) return;

    let cancelled = false;

    const apply = (row: {
      id: string;
      status: PrintJobStatus;
      last_error?: string | null;
    }) => {
      if (cancelled) return;
      setStatuses((prev) => ({ ...prev, [row.id]: row.status }));
      if (row.last_error && TERMINAL_BAD.includes(row.status)) {
        setError(row.last_error);
      }
    };

    void (async () => {
      const { data } = await supabase
        .from("print_jobs")
        .select("id, status, last_error")
        .in("id", ids);
      (data ?? []).forEach((row) =>
        apply(row as { id: string; status: PrintJobStatus; last_error: string | null }),
      );
    })();

    const channel = supabase
      .channel(`print-jobs-${ids[0]}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "print_jobs" },
        (payload) => {
          const row = payload.new as {
            id: string;
            status: PrintJobStatus;
            last_error: string | null;
          };
          if (!ids.includes(row.id)) return;
          apply(row);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [key]);

  return { phase: collapse(statuses), error, statuses };
}
