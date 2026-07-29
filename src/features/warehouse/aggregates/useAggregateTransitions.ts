/**
 * Typed WMS aggregate transition wrappers (ADR 0101 — Phase 2.4 §2).
 *
 * Every warehouse aggregate (wave, manifest, QC inspection, cycle-count
 * session) has a SECURITY DEFINER RPC `wms_transition_<aggregate>` that
 * validates the FSM edge, checks the optimistic `row_version` lock,
 * stamps lifecycle timestamps, and publishes a `warehouse.<aggregate>.*`
 * event to `business_event_outbox`.
 *
 * UI code MUST route lifecycle changes through these hooks — never write
 * `state` directly to `wms_pick_waves`, `wms_loading_manifests`,
 * `wms_qc_inspections`, or `wms_count_sessions`. The
 * `wms-no-direct-state-writes` architecture guard enforces this.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type WaveState =
  | "draft"
  | "released"
  | "picking"
  | "picked"
  | "packing"
  | "packed"
  | "cancelled";

export type ManifestState =
  | "draft"
  | "loading"
  | "closed"
  | "dispatched"
  | "cancelled";

export type QcState =
  | "pending"
  | "in_progress"
  | "passed"
  | "failed"
  | "conditional"
  | "closed"
  | "cancelled";

export type CountSessionState =
  | "draft"
  | "counting"
  | "review"
  | "posted"
  | "cancelled";

interface TransitionResult {
  row_version: number;
  state: string;
}

interface TransitionInput<S extends string> {
  id: string;
  toState: S;
  rowVersion: number;
  reason?: string;
  payload?: Record<string, unknown>;
}

function buildTransition<S extends string>(
  rpcName:
    | "wms_transition_wave"
    | "wms_transition_manifest"
    | "wms_transition_qc"
    | "wms_transition_count_session",
  idParam:
    | "p_wave_id"
    | "p_manifest_id"
    | "p_qc_id"
    | "p_session_id",
  invalidateKeys: string[][],
  aggregateLabel: string,
) {
  return function useTransition() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: async (input: TransitionInput<S>) => {
        const { data, error } = await supabase.rpc(rpcName as any, {
          [idParam]: input.id,
          p_to_state: input.toState,
          p_row_version: input.rowVersion,
          p_reason: input.reason ?? null,
          p_payload: input.payload ?? {},
        } as any);
        if (error) throw error;
        return (data ?? null) as TransitionResult | null;
      },
      onSuccess: () => {
        for (const key of invalidateKeys) {
          qc.invalidateQueries({ queryKey: key });
        }
      },
      onError: (e: any) => {
        const msg = String(e?.message ?? "");
        if (msg.includes("Row version mismatch")) {
          toast.error(
            `Someone else just updated this ${aggregateLabel}. Refresh and try again.`,
          );
        } else if (msg.includes("Illegal")) {
          toast.error(`That ${aggregateLabel} transition is not allowed.`);
        } else {
          toast.error(msg || `Could not update ${aggregateLabel}`);
        }
      },
    });
  };
}

export const useWaveTransition = buildTransition<WaveState>(
  "wms_transition_wave",
  "p_wave_id",
  [["wms_pick_waves"], ["wms_tasks"]],
  "wave",
);

export const useManifestTransition = buildTransition<ManifestState>(
  "wms_transition_manifest",
  "p_manifest_id",
  [["wms_loading_manifests"], ["wms_pack_cartons"]],
  "manifest",
);

export const useQcTransition = buildTransition<QcState>(
  "wms_transition_qc",
  "p_qc_id",
  [["wms_qc_inspections"]],
  "QC inspection",
);

export const useCountSessionTransition = buildTransition<CountSessionState>(
  "wms_transition_count_session",
  "p_session_id",
  [["wms_count_sessions"], ["wms_count_lines"]],
  "count session",
);
