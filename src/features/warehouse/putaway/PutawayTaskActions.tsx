/**
 * PutawayTaskActions — the supervisor-side controls for one putaway task.
 *
 * Three enterprise capabilities the board previously lacked:
 *   1. Reassign — pick a different bin; the server re-runs the feasibility
 *      contract (capacity/weight/volume/temperature/hazmat/mixing) and only
 *      accepts an unsuitable bin with a recorded override reason.
 *   2. Partial putaway — store part of the plate now, keep the remainder as
 *      an open task with its own plate for the stored portion.
 *   3. Report a problem — raise a first-class WMS exception (bin full,
 *      blocked bin, damaged goods, wrong bin) instead of silently stalling.
 *
 * All three go through SECURITY DEFINER RPCs; nothing here mutates stock.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Scissors, MapPin } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/design-system";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";
import { usePutawayBins, usePutawaySuggestions } from "./usePutawayData";

type ExceptionKind =
  | "capacity_exceeded"
  | "invalid_bin"
  | "damaged_goods"
  | "wrong_location"
  | "unsafe_storage"
  | "other";

const EXCEPTION_KINDS: { value: ExceptionKind; label: string }[] = [
  { value: "capacity_exceeded", label: "Bin full / no capacity" },
  { value: "invalid_bin", label: "Bin blocked or unusable" },
  { value: "damaged_goods", label: "Goods damaged" },
  { value: "wrong_location", label: "Stock is not where expected" },
  { value: "unsafe_storage", label: "Unsafe to store here" },
  { value: "other", label: "Other" },
];

export interface PutawayTaskLike {
  id: string;
  warehouse_id: string;
  quantity: number | null;
  destination_location_id: string | null;
  /**
   * Optimistic lock the server checks (Phase 3). Both reassign and partial
   * putaway reject a stale version, so the board must pass the version it
   * rendered — never omit it.
   */
  row_version: number;
}


interface Props {
  task: PutawayTaskLike;
  disabled?: boolean;
  /** Compact icon-only buttons for dense boards. */
  compact?: boolean;
}

export function PutawayTaskActions({ task, disabled, compact }: Props) {
  const qc = useQueryClient();
  const [openKind, setOpenKind] = useState<null | "reassign" | "split" | "exception">(null);
  const [bin, setBin] = useState<string>("");
  const [reason, setReason] = useState("");
  const [qty, setQty] = useState("");
  const [kind, setKind] = useState<ExceptionKind>("capacity_exceeded");

  const bins = usePutawayBins(openKind ? task.warehouse_id : null);
  const suggestions = usePutawaySuggestions(openKind === "reassign" ? task.id : null);

  const close = () => {
    setOpenKind(null);
    setBin("");
    setReason("");
    setQty("");
  };

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["wms-putaway"] });
    qc.invalidateQueries({ queryKey: ["wms-tasks"] });
    qc.invalidateQueries({ queryKey: ["wms-lpns"] });
    qc.invalidateQueries({ queryKey: ["wms-putaway-suggestions"] });
    qc.invalidateQueries({ queryKey: ["wms_exceptions"] });
  };

  const reassign = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("wms_reassign_putaway_task", {
        p_task_id: task.id,
        p_location_id: bin,
        p_reason: reason.trim() || undefined,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Destination updated"); refresh(); close(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Reassign failed"),
  });

  const split = useMutation({
    mutationFn: async () => {
      // Routed through the replay-guarded dispatcher so a handheld can do
      // this offline without double-storing the portion on reconnect.
      await enqueue("wms_split_putaway_task", {
        p_task_id: task.id,
        p_quantity: Number(qty),
        p_location_id: bin || null,
        p_reason: reason.trim() || null,
      });
    },
    onSuccess: () => { toast.success("Partial putaway stored"); refresh(); close(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Partial putaway failed"),
  });

  const raise = useMutation({
    mutationFn: async () => {
      await enqueue("wms_report_putaway_exception", {
        p_task_id: task.id,
        p_kind: kind,
        p_reason: reason.trim(),
      });
    },
    onSuccess: () => { toast.success("Exception raised"); refresh(); close(); },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not raise exception"),
  });

  const busy = reassign.isPending || split.isPending || raise.isPending;
  const binOptions = bins.data ?? [];

  const BinSelect = (
    <div className="space-y-1.5">
      <Label>Bin</Label>
      <Select value={bin} onValueChange={setBin}>
        <SelectTrigger><SelectValue placeholder="Choose a bin" /></SelectTrigger>
        <SelectContent className="max-h-72">
          {binOptions.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.code}
              {b.storage_role ? ` · ${b.storage_role}` : ""}
              {b.is_blocked ? " · blocked" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setOpenKind("reassign")}>
        <MapPin className="h-3.5 w-3.5" />{compact ? null : <span className="ml-1">Reassign</span>}
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setOpenKind("split")}>
        <Scissors className="h-3.5 w-3.5" />{compact ? null : <span className="ml-1">Partial</span>}
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setOpenKind("exception")}>
        <AlertTriangle className="h-3.5 w-3.5" />{compact ? null : <span className="ml-1">Problem</span>}
      </Button>

      <Dialog open={openKind === "reassign"} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign destination bin</DialogTitle>
            <DialogDescription>
              The bin is re-checked against capacity, weight, volume, temperature, hazard
              class and mixing rules. An unsuitable bin needs a recorded reason.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {(suggestions.data ?? []).length > 0 && (
              <div className="space-y-1.5">
                <Label>Engine suggestions</Label>
                <ul className="space-y-1 text-sm">
                  {(suggestions.data ?? []).map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        className="font-mono underline-offset-2 hover:underline"
                        onClick={() => setBin(s.location_id)}
                      >
                        {s.location?.code ?? "—"}
                      </button>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {s.strategy && <StatusBadge tone="info">{s.strategy.replace(/_/g, " ")}</StatusBadge>}
                        {s.feasible_qty != null ? `fits ${Number(s.feasible_qty)}` : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {BinSelect}
            <div className="space-y-1.5">
              <Label htmlFor="reassign-reason">Reason (required to override a rejection)</Label>
              <Textarea id="reassign-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button disabled={!bin || busy} onClick={() => reassign.mutate()}>Reassign</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={openKind === "split"} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Partial putaway</DialogTitle>
            <DialogDescription>
              Store part of the plate now. The remainder stays on this task with its own
              open quantity{task.quantity != null ? ` (currently ${Number(task.quantity)})` : ""}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="split-qty">Quantity to store now</Label>
              <Input
                id="split-qty" type="number" min="0" step="any"
                value={qty} onChange={(e) => setQty(e.target.value)}
              />
            </div>
            {BinSelect}
            <div className="space-y-1.5">
              <Label htmlFor="split-reason">Reason (optional)</Label>
              <Textarea id="split-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button
              disabled={busy || !qty || Number(qty) <= 0}
              onClick={() => split.mutate()}
            >
              Store portion
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={openKind === "exception"} onOpenChange={(o) => (o ? null : close())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a putaway problem</DialogTitle>
            <DialogDescription>
              The task is flagged and a warehouse exception is raised with the task,
              plate and bin attached.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Problem</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as ExceptionKind)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXCEPTION_KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exc-reason">What happened?</Label>
              <Textarea id="exc-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={busy || reason.trim().length < 3}
              onClick={() => raise.mutate()}
            >
              Raise exception
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default PutawayTaskActions;