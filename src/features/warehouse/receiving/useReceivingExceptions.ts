/**
 * useReceivingExceptions — Receiving audit, Phase 5c.
 *
 * `wms_flag_receiving_variances` raises one `wms_exceptions` row per offending
 * line (`aggregate_type = 'receiving_line'`, `details.session_id` = session).
 * Until now the only place to see or clear those rows was the warehouse-wide
 * Exceptions Inbox — which means the supervisor standing at the dock had to
 * leave the trailer to unblock it.
 *
 * This hook scopes the same rows to the session on screen and resolves them
 * through the canonical FSM RPC (`wms_resolve_exception`, optimistic-locked on
 * `row_version`). No direct state writes — ADR 0101 §1.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type ReceivingExceptionState =
  | "open" | "acknowledged" | "investigating" | "escalated" | "resolved" | "wont_fix";

export type ReceivingResolutionKind =
  | "short_scan" | "damaged" | "wrong_bin" | "wrong_lp" | "legacy_short_dispatch"
  | "miscount" | "process_error" | "system_error" | "other";

export interface ReceivingException {
  id: string;
  kind: string;
  state: ReceivingExceptionState;
  severity: number;
  reason: string | null;
  aggregate_id: string | null;
  due_by: string | null;
  row_version: number;
  created_at: string;
  details: Record<string, unknown> | null;
}

export const RECEIVING_OPEN_EXCEPTION_STATES: ReceivingExceptionState[] = [
  "open", "acknowledged", "investigating", "escalated",
];

export function useReceivingExceptions(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["wms_exceptions", "receiving-session", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_exceptions" as never)
        .select("id, kind, state, severity, reason, aggregate_id, due_by, row_version, created_at, details")
        .eq("aggregate_type", "receiving_line")
        .contains("details", { session_id: sessionId })
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return ((data ?? []) as unknown) as ReceivingException[];
    },
  });
}

export function useResolveReceivingException() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      to: ReceivingExceptionState;
      rowVersion: number;
      resolution?: string | null;
      resolutionKind?: ReceivingResolutionKind | null;
    }) => {
      const { error } = await supabase.rpc("wms_resolve_exception" as never, {
        p_exception_id: input.id,
        p_to_state: input.to,
        p_row_version: input.rowVersion,
        p_resolution: input.resolution?.trim() ? input.resolution.trim() : null,
        p_resolution_kind: input.resolutionKind ?? null,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["wms_exceptions"] });
      void qc.invalidateQueries({ queryKey: ["wms_receiving_lines"] });
    },
  });
}
