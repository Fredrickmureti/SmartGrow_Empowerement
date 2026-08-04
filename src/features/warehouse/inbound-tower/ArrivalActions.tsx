/**
 * Supervisor actions on an arrival.
 *
 * The tower is a control surface, not a report: the one next step a
 * supervisor takes while looking at a late truck happens here, in place, and
 * it goes through the same guarded server routines the gate and dock use
 * (`mark_appointment_arrived`) — never a direct table write. Where the next
 * step needs floor context the tower does not have (which dock, which
 * pallet), it hands off to the surface that owns it rather than guessing.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { INBOUND_QUERY_PREFIXES } from "./useInboundTower";
import type { InboundArrival } from "./contract";

export function ArrivalActions({ arrival }: { arrival: InboundArrival }) {
  const qc = useQueryClient();

  const markArrived = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("mark_appointment_arrived" as never, {
        p_appointment_id: arrival.appointment_id!,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Arrival recorded");
      INBOUND_QUERY_PREFIXES.forEach((key) =>
        qc.invalidateQueries({ queryKey: [...key] }),
      );
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : "Could not record the arrival"),
  });

  // Booked but not on site — the gate action.
  if (arrival.lifecycle_stage === "appointment" && arrival.appointment_id) {
    return (
      <Button
        size="sm"
        disabled={markArrived.isPending}
        onClick={() => markArrived.mutate()}
      >
        Mark arrived
      </Button>
    );
  }

  // On site with no dock — dock assignment belongs to the yard marshal.
  if (
    (arrival.lifecycle_stage === "gate" || arrival.lifecycle_stage === "yard") &&
    !arrival.dock_id
  ) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/warehouse-app/yard/marshal">Assign dock</Link>
      </Button>
    );
  }

  // Docked with nothing being received yet — start the unload.
  if (arrival.lifecycle_stage === "dock" && !arrival.session_id) {
    return (
      <Button asChild size="sm">
        <Link to="/warehouse-app/receiving">Start receiving</Link>
      </Button>
    );
  }

  // Awaiting a quality decision — the blocking step is the inspection.
  if (arrival.qc_pending > 0) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to="/warehouse-app/qc">Decide QC</Link>
      </Button>
    );
  }

  return null;
}
