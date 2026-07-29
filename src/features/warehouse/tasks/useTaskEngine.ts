/**
 * Task engine hook (ADR 0101 — Phase 1.2).
 *
 * Thin, typed wrapper around the DB-side FSM:
 *   - `wms_claim_next_task`   — atomic SKIP LOCKED claim with lease.
 *   - `wms_transition_task`   — guarded state transition, emits outbox.
 *   - `wms_task_heartbeat`    — extends the lease for long-running work.
 *   - `wms_task_reap_expired` — supervisor sweep for abandoned leases.
 *
 * UI code MUST NOT `UPDATE wms_tasks` directly — go through these RPCs so
 * the FSM guards, row_version optimistic lock, and event outbox stay in
 * sync.
 */
import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { WmsTaskType, WmsTaskState } from "../events/topics";

export interface ClaimNextInput {
  warehouseId: string;
  taskTypes?: WmsTaskType[];
  leaseSeconds?: number;
}

export interface TransitionInput {
  taskId: string;
  toState: WmsTaskState;
  rowVersion: number;
  reason?: string;
  payload?: Record<string, unknown>;
}

export function useTaskEngine() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["wms_tasks"] });

  const claimNext = useMutation({
    mutationFn: async (input: ClaimNextInput) => {
      const { data, error } = await supabase.rpc("wms_claim_next_task" as any, {
        _warehouse_id: input.warehouseId,
        _task_types: input.taskTypes ?? null,
        _lease_seconds: input.leaseSeconds ?? 300,
      });
      if (error) throw error;
      // SETOF wms_tasks — grab first row (or null when queue is empty)
      const row = Array.isArray(data) ? data[0] : data;
      return {
        task_id: (row?.id as string | undefined) ?? null,
        row_version: (row?.row_version as number | undefined) ?? null,
      };
    },
    onSuccess: (res) => {
      invalidate();
      if (!res?.task_id) toast.message("No tasks available in your queue.");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not claim task"),
  });

  const transition = useMutation({
    mutationFn: async (input: TransitionInput) => {
      const { data, error } = await supabase.rpc("wms_transition_task" as any, {
        _task_id: input.taskId,
        _to_state: input.toState,
        _expected_version: input.rowVersion,
        _reason: input.reason ?? null,
        _payload_patch: input.payload ?? {},
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return { row_version: (row?.row_version as number) ?? input.rowVersion + 1 };
    },
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e?.message ?? "Transition rejected"),
  });

  const heartbeat = useCallback(
    async (taskId: string) => {
      const { error } = await supabase.rpc("wms_task_heartbeat" as any, {
        _task_id: taskId,
      });
      if (error) console.warn("[task-engine] heartbeat failed", error);
    },
    [],
  );

  const reapExpired = useMutation({
    // wms_task_reap_expired() takes no args and returns the number of tasks released.
    mutationFn: async (_warehouseId: string) => {
      const { data, error } = await supabase.rpc("wms_task_reap_expired" as any);
      if (error) throw error;
      return { released: typeof data === "number" ? data : 0 };
    },
    onSuccess: (res) => {
      invalidate();
      toast.success(`Released ${res?.released ?? 0} abandoned tasks.`);
    },
    onError: (e: any) => toast.error(e?.message ?? "Reap failed"),
  });

  return { claimNext, transition, heartbeat, reapExpired };
}
