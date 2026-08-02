/**
 * Lifecycle action rail — rendered from the database FSM, never from UI
 * conditionals.
 *
 * `wms_lpn_status_edges` is the single rulebook: it says which status
 * changes are legal from the plate's current status, which verb to show,
 * whether a reason is mandatory, and which dedicated RPC owns the edge
 * (seal / dispatch / receive return / retire). Anything the rail offers is
 * something the database will accept.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ChevronRight } from "lucide-react";
import {
  useLpnAllowedTransitions, useLpnAction,
  type LpnAction, type LpnOverviewRow, type LpnStatusEdge,
} from "./useLpnOps";

export interface LpnLifecycleRailProps {
  plate: LpnOverviewRow;
  /** Bins in the plate's warehouse — required for the return edge. */
  locations?: Array<{ id: string; code: string; name: string | null }>;
}

function edgeToAction(
  edge: LpnStatusEdge,
  plate: LpnOverviewRow,
  reason: string,
  locationId: string,
): LpnAction {
  const expectedVersion = plate.row_version;
  switch (edge.rpc_name) {
    case "wms_lpn_seal":
      return { kind: "seal", expectedVersion };
    case "wms_lpn_dispatch":
      return { kind: "dispatch", expectedVersion, reference: reason || null };
    case "wms_lpn_receive_return":
      return { kind: "return", expectedVersion, reason, toLocationId: locationId };
    case "wms_lpn_retire":
      return { kind: "retire", expectedVersion, reason };
    default:
      return { kind: "transition", toStatus: edge.to_status, expectedVersion, reason: reason || null };
  }
}

/** Edges that need operator input before they can be submitted. */
function needsPrompt(edge: LpnStatusEdge) {
  return edge.requires_reason || edge.rpc_name === "wms_lpn_receive_return";
}

export function LpnLifecycleRail({ plate, locations = [] }: LpnLifecycleRailProps) {
  const { data: edges, isLoading } = useLpnAllowedTransitions(plate.status);
  const action = useLpnAction(plate.id);
  const [pending, setPending] = useState<LpnStatusEdge | null>(null);
  const [reason, setReason] = useState("");
  const [locationId, setLocationId] = useState("");

  const close = () => {
    setPending(null);
    setReason("");
    setLocationId("");
  };

  const submit = () => {
    if (!pending) return;
    action.run(edgeToAction(pending, plate, reason.trim(), locationId), { onSuccess: close });
  };

  if (isLoading || !edges?.length) return null;

  const needsBin = pending?.rpc_name === "wms_lpn_receive_return";
  const canSubmit =
    !!pending &&
    (!pending.requires_reason || reason.trim().length > 0) &&
    (!needsBin || !!locationId);

  return (
    <>
      {edges.map((edge) => (
        <Button
          key={`${edge.from_status}-${edge.to_status}`}
          variant="outline"
          disabled={action.isPending}
          title={edge.description ?? undefined}
          onClick={() =>
            needsPrompt(edge)
              ? setPending(edge)
              : action.run(edgeToAction(edge, plate, "", ""))
          }
        >
          <ChevronRight className="mr-2 h-4 w-4" />
          {edge.verb}
        </Button>
      ))}

      <Dialog open={!!pending} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.verb}</DialogTitle>
            <DialogDescription>
              {pending?.description ??
                `Move ${plate.code} from ${pending?.from_status} to ${pending?.to_status}.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {needsBin && (
              <div className="space-y-2">
                <Label>Receiving bin</Label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger><SelectValue placeholder="Where does it land?" /></SelectTrigger>
                  <SelectContent>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.code} {l.name ?? ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>{pending?.requires_reason ? "Reason (required)" : "Note"}</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Recorded on the plate's handling ledger"
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button onClick={submit} disabled={!canSubmit || action.isPending}>
              {pending?.verb}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}