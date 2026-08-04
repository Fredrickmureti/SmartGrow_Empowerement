/**
 * Supervisor actions on a shipment.
 *
 * The tower is a control surface, not a report: the state changes a
 * supervisor makes while looking at a late load happen here, in place, and
 * they go through the same guarded state machines the floor uses
 * (`wms_transition_wave`, `wms_transition_manifest`) — never through a
 * direct table write. Optimistic-concurrency `row_version` is read at click
 * time so a stale board can never overwrite a floor decision.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { OUTBOUND_QUERY_PREFIXES } from "./useOutboundTower";
import type { OutboundShipment } from "./contract";

type Action = { label: string; run: () => Promise<void> };

async function transitionWave(waveId: string, to: string) {
  const { data: row, error: readErr } = await supabase
    .from("wms_pick_waves")
    .select("row_version")
    .eq("id", waveId)
    .single();
  if (readErr) throw readErr;
  const { error } = await supabase.rpc("wms_transition_wave", {
    p_wave_id: waveId,
    p_to_state: to as never,
    p_row_version: row.row_version as number,
    p_reason: "Supervisor action from outbound control tower",
  });
  if (error) throw error;
}

async function transitionManifest(manifestId: string, to: string) {
  const { data: row, error: readErr } = await supabase
    .from("wms_loading_manifests")
    .select("row_version")
    .eq("id", manifestId)
    .single();
  if (readErr) throw readErr;
  const { error } = await supabase.rpc("wms_transition_manifest", {
    p_manifest_id: manifestId,
    p_to_state: to as never,
    p_row_version: row.row_version as number,
    p_reason: "Supervisor action from outbound control tower",
  });
  if (error) throw error;
}

/** The single next step a supervisor can take on this load, if any. */
function nextAction(s: OutboundShipment): Action | null {
  if (s.wave_id && s.wave_state === "draft") {
    return { label: "Release", run: () => transitionWave(s.wave_id!, "released") };
  }
  if (s.manifest_id && s.manifest_state === "loading" && s.load_pct === 100) {
    return { label: "Close load", run: () => transitionManifest(s.manifest_id!, "closed") };
  }
  if (s.manifest_id && s.manifest_state === "closed") {
    return {
      label: "Dispatch",
      run: () => transitionManifest(s.manifest_id!, "dispatched"),
    };
  }
  return null;
}

export function ShipmentActions({ shipment }: { shipment: OutboundShipment }) {
  const qc = useQueryClient();
  const action = nextAction(shipment);

  const mutation = useMutation({
    mutationFn: async () => action?.run(),
    onSuccess: () => {
      toast.success(`${action?.label} applied`);
      OUTBOUND_QUERY_PREFIXES.forEach((key) =>
        qc.invalidateQueries({ queryKey: [...key] }),
      );
    },
    onError: (err: unknown) =>
      toast.error(
        err instanceof Error ? err.message : "Could not apply that action",
      ),
  });

  if (!action) return null;

  // Dispatching without proof of seal/signature is the classic outbound
  // control failure; the tower refuses it rather than warning about it.
  const blockedByProof = action.label === "Dispatch" && !shipment.has_proof;

  return (
    <Button
      size="sm"
      variant={blockedByProof ? "outline" : "default"}
      disabled={mutation.isPending || blockedByProof}
      title={blockedByProof ? "Capture proof before dispatch" : undefined}
      onClick={() => mutation.mutate()}
    >
      {blockedByProof ? "Proof required" : action.label}
    </Button>
  );
}
