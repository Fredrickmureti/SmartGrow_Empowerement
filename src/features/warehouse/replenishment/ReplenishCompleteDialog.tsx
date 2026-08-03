/**
 * Replenishment completion capture (ADR 0106).
 *
 * The only UI path that closes a `replenish` task. It calls
 * `complete_replenish_task`, which moves the stock (source bin -> pick
 * face), releases the reservation, closes the linked replenishment
 * order, and raises a `short_pick` exception when the operator moved
 * less than requested. Direct `UPDATE wms_tasks` is forbidden.
 *
 * Scan fields are optional but validated server-side against the task's
 * source and destination location codes/barcodes, so an operator who
 * scans the wrong bin is rejected before any movement is written.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

export interface ReplenishTaskLike {
  id: string;
  quantity: number | null;
  lot_number: string | null;
  source_loc: { code: string } | null;
  dest_loc: { code: string } | null;
}

interface Props {
  task: ReplenishTaskLike | null;
  onOpenChange: (open: boolean) => void;
}

export function ReplenishCompleteDialog({ task, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [movedQty, setMovedQty] = useState("");
  const [sourceScan, setSourceScan] = useState("");
  const [destScan, setDestScan] = useState("");

  useEffect(() => {
    if (task) {
      setMovedQty(task.quantity != null ? String(task.quantity) : "");
      setSourceScan("");
      setDestScan("");
    }
  }, [task]);

  const complete = useMutation({
    mutationFn: async () => {
      if (!task) throw new Error("No task selected");
      const qty = Number(movedQty);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error("Enter the quantity actually moved");
      return replayGuardedCall("complete_replenish_task", {
        p_task_id: task.id,
        p_moved_qty: qty,
        p_source_scan: sourceScan.trim() || null,
        p_destination_scan: destScan.trim() || null,
        p_lot_number: task.lot_number,
      });
    },
    onSuccess: (res: unknown) => {
      const short = (res as { short?: boolean } | null)?.short;
      toast[short ? "warning" : "success"](
        short ? "Replenishment closed short — exception raised" : "Pick face replenished",
      );
      qc.invalidateQueries({ queryKey: ["wms_tasks"] });
      qc.invalidateQueries({ queryKey: ["wms-replen-tasks"] });
      qc.invalidateQueries({ queryKey: ["wms-replen-orders"] });
      qc.invalidateQueries({ queryKey: ["wms_exceptions"] });
      onOpenChange(false);
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not complete replenishment"),
  });

  return (
    <Dialog open={!!task} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Complete replenishment</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{task?.source_loc?.code ?? "—"}</span>
            {" → "}
            <span className="font-mono">{task?.dest_loc?.code ?? "—"}</span>
            {task?.lot_number ? ` · lot ${task.lot_number}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="replen-src">Scan source bin (optional)</Label>
            <Input
              id="replen-src"
              autoFocus
              value={sourceScan}
              onChange={(e) => setSourceScan(e.target.value)}
              placeholder={task?.source_loc?.code ?? "Bin barcode"}
            />
          </div>
          <div>
            <Label htmlFor="replen-dst">Scan pick face (optional)</Label>
            <Input
              id="replen-dst"
              value={destScan}
              onChange={(e) => setDestScan(e.target.value)}
              placeholder={task?.dest_loc?.code ?? "Pick face barcode"}
            />
          </div>
          <div>
            <Label htmlFor="replen-qty">Quantity moved</Label>
            <Input
              id="replen-qty"
              type="number"
              min="0"
              step="any"
              value={movedQty}
              onChange={(e) => setMovedQty(e.target.value)}
            />
            {task?.quantity != null && Number(movedQty) < Number(task.quantity) && (
              <p className="mt-1 text-xs text-muted-foreground">
                Less than the requested {Number(task.quantity)} — a short-pick exception will be raised.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => complete.mutate()} disabled={complete.isPending}>
            Confirm move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
