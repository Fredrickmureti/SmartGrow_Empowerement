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
        p_warehouse_id: input.warehouseId,
        p_task_types: input.taskTypes ?? null,
        p_lease_seconds: input.leaseSeconds ?? 300,
      });
      if (error) throw error;
      return data as { task_id: string | null; row_version: number | null };
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
        p_task_id: input.taskId,
        p_to_state: input.toState,
        p_row_version: input.rowVersion,
        p_reason: input.reason ?? null,
        p_payload: input.payload ?? {},
      });
      if (error) throw error;
      return data as { row_version: number };
    },
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e?.message ?? "Transition rejected"),
  });

  const heartbeat = useCallback(
    async (taskId: string) => {
      const { error } = await supabase.rpc("wms_task_heartbeat" as any, {
        p_task_id: taskId,
      });
      if (error) console.warn("[task-engine] heartbeat failed", error);
    },
    [],
  );

  const reapExpired = useMutation({
    mutationFn: async (warehouseId: string) => {
      const { data, error } = await supabase.rpc("wms_task_reap_expired" as any, {
        p_warehouse_id: warehouseId,
      });
      if (error) throw error;
      return data as { released: number };
    },
    onSuccess: (res) => {
      invalidate();
      toast.success(`Released ${res?.released ?? 0} abandoned tasks.`);
    },
    onError: (e: any) => toast.error(e?.message ?? "Reap failed"),
  });

  return { claimNext, transition, heartbeat, reapExpired };
}
