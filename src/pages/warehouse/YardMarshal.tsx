/**
 * Yard Marshal (ADR 0086 Phase 6) — the handheld surface for the jockey.
 *
 * The control tower dispatches yard moves; this is where they are executed
 * on the ground. Designed for a glove-sized touch target and a scanner:
 *
 *   1. Scan the trailer placard (`yard.trailer`) → selects its work order.
 *   2. Drive the trailer to the destination.
 *   3. Scan the yard slot / dock label (`yard.slot`) → the move is
 *      confirmed server-side, so a trailer cannot be dropped in the wrong
 *      place without the system knowing.
 *
 * Every write goes through the same RPC layer as the control tower
 * (`complete_yard_move` → `relocate_trailer` / `assign_trailer_to_dock`),
 * so the movement ledger and the outbox stay authoritative.
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, PageBody, LoadingState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowRight, CheckCircle2, ScanBarcode, Truck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useWarehouses } from "@/features/warehouse/dock/useDockScheduling";
import { useWmsScanIntent } from "@/features/warehouse/scanning/wmsScanIntent";
import { ScanCameraButton } from "@/components/scanner/ScanCameraButton";
import {
  useCancelYardMove,
  useCompleteYardMove,
  useYardDocks,
  useYardMoveTasks,
  useYardSlots,
  useYardVisits,
} from "@/features/warehouse/yard/useYard";
import {
  yardTaskDestination,
  yardTaskStateLabel,
  type YardMoveTaskRow,
} from "@/features/warehouse/yard/yardModel";

export default function YardMarshal() {
  const [warehouseId, setWarehouseId] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [destCode, setDestCode] = useState("");

  const warehouses = useWarehouses();
  const effectiveWarehouse = warehouseId || warehouses.data?.[0]?.id || "";
  const tasks = useYardMoveTasks(effectiveWarehouse || null);
  const slots = useYardSlots(effectiveWarehouse || null);
  const docks = useYardDocks(effectiveWarehouse || null);
  const visits = useYardVisits(effectiveWarehouse || null);

  const complete = useCompleteYardMove();
  const cancel = useCancelYardMove();

  const openTasks = tasks.data ?? [];
  const activeTask = useMemo(
    () => openTasks.find((t) => t.id === activeTaskId) ?? null,
    [openTasks, activeTaskId],
  );

  const originLabel = useCallback(
    (t: YardMoveTaskRow) => {
      const visit = (visits.data ?? []).find((v) => v.id === t.payload?.visit_id);
      return visit?.slot?.code || visit?.dock?.name || visit?.dock?.code || "Gate";
    },
    [visits.data],
  );

  function finish(code: string | null) {
    if (!activeTask) return;
    complete.mutate(
      { taskId: activeTask.id, confirmedCode: code },
      {
        onSuccess: () => {
          setActiveTaskId(null);
          setDestCode("");
        },
      },
    );
  }

  /* Step 1 — the trailer placard picks the work order. */
  const trailerScan = useWmsScanIntent({
    intent: "yard.trailer",
    enabled: !activeTask,
    onScan: ({ resolveCode }) => {
      const code = resolveCode.trim().toUpperCase();
      const match = openTasks.find(
        (t) => (t.payload?.trailer_ref ?? "").toUpperCase() === code,
      );
      if (!match) {
        trailerScan.reportUnexpected(resolveCode, `No open yard move for ${code}`);
        return;
      }
      setActiveTaskId(match.id);
      toast.success(`${code} — move to ${yardTaskDestination(match, slots.data ?? [], docks.data ?? [])}`);
    },
  });

  /* Step 2 — the destination label confirms the drop. */
  useWmsScanIntent({
    intent: "yard.slot",
    enabled: !!activeTask,
    onScan: ({ resolveCode }) => {
      setDestCode(resolveCode.trim().toUpperCase());
      finish(resolveCode.trim());
    },
  });

  return (
    <>
      <PageHeader
        title="Yard Marshal"
        description="Scan the trailer, drive it, scan the destination. Every move is confirmed against the dispatched work order."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/warehouse-app/yard">Control tower</Link>
          </Button>
        }
      />

      <PageBody>
        <Select value={effectiveWarehouse} onValueChange={setWarehouseId}>
          <SelectTrigger className="w-full sm:w-[280px] h-11">
            <SelectValue placeholder="Select warehouse" />
          </SelectTrigger>
          <SelectContent>
            {(warehouses.data ?? []).map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {activeTask ? (
          /* ---- Execution card ------------------------------------- */
          <Card className="border-primary/60">
            <CardContent className="p-4 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-lg font-semibold flex items-center gap-2">
                  <Truck className="h-5 w-5" />
                  {activeTask.payload?.trailer_ref ?? "Trailer"}
                </span>
                <Badge variant="outline">{yardTaskStateLabel(activeTask.state)}</Badge>
              </div>

              <div className="flex items-center gap-3 text-sm">
                <span className="text-muted-foreground">{originLabel(activeTask)}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <span className="font-semibold text-base">
                  {yardTaskDestination(activeTask, slots.data ?? [], docks.data ?? [])}
                </span>
              </div>

              <div className="space-y-2">
                <Label className="text-xs flex items-center gap-1.5">
                  <ScanBarcode className="h-3.5 w-3.5" /> Scan the destination label
                </Label>
                <div className="flex gap-2">
                  <Input
                    className="h-12 text-base"
                    inputMode="text"
                    autoFocus
                    value={destCode}
                    onChange={(e) => setDestCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && destCode.trim()) finish(destCode.trim());
                    }}
                    placeholder="Slot or dock code"
                  />
                  <ScanCameraButton label="Scan destination" />
                </div>
              </div>

              <div className="min-w-0 grid grid-cols-2 gap-2">
                <Button
                  className="h-12 gap-1.5"
                  disabled={complete.isPending}
                  onClick={() => finish(destCode.trim() || null)}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {destCode.trim() ? "Confirm drop" : "Complete without scan"}
                </Button>
                <Button
                  variant="outline"
                  className="h-12"
                  onClick={() => {
                    setActiveTaskId(null);
                    setDestCode("");
                  }}
                >
                  Back to list
                </Button>
              </div>

              <Button
                variant="ghost"
                size="sm"
                className="text-destructive gap-1.5"
                disabled={cancel.isPending}
                onClick={() =>
                  cancel.mutate(
                    { taskId: activeTask.id, reason: "Cancelled by yard marshal" },
                    { onSuccess: () => setActiveTaskId(null) },
                  )
                }
              >
                <XCircle className="h-3.5 w-3.5" /> Cannot do this move
              </Button>
            </CardContent>
          </Card>
        ) : tasks.isLoading ? (
          <LoadingState />
        ) : openTasks.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center text-sm text-muted-foreground">
              No yard moves waiting. Scan a trailer placard when one is dispatched.
            </CardContent>
          </Card>
        ) : (
          /* ---- Work order queue ----------------------------------- */
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground flex-1">
                {openTasks.length} move{openTasks.length === 1 ? "" : "s"} waiting — scan a trailer or tap one.
              </p>
              <ScanCameraButton label="Scan trailer placard" />
            </div>
            {openTasks.map((t) => (
              <button
                key={t.id}
                type="button"
                className="w-full text-left"
                onClick={() => setActiveTaskId(t.id)}
              >
                <Card className="hover:border-primary/60 transition-colors">
                  <CardContent className="p-4 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold flex items-center gap-2">
                        <Truck className="h-4 w-4 text-muted-foreground" />
                        {t.payload?.trailer_ref ?? "Trailer"}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {yardTaskStateLabel(t.state)}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground flex items-center gap-2">
                      {originLabel(t)}
                      <ArrowRight className="h-3.5 w-3.5" />
                      <span className="text-foreground font-medium">
                        {yardTaskDestination(t, slots.data ?? [], docks.data ?? [])}
                      </span>
                    </p>
                    {t.notes && <p className="text-xs text-muted-foreground">{t.notes}</p>}
                  </CardContent>
                </Card>
              </button>
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}
