/**
 * TaskHistorySheet — the operator-task audit trail.
 *
 * Renders `wms_task_events`, the append-only execution ledger written by
 * the `trg_wms_tasks_log_event` trigger. This is the answer to "who did
 * what, when, on which device, at which bin, with which barcode and
 * quantity" — reconstructible months later.
 *
 * The ledger is immutable at the database level (append-only trigger), so
 * this component is strictly read-only by design.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { StatusBadge, LoadingState, EmptyState } from "@/design-system";
import { History } from "lucide-react";
import { useWarehouseQtyFormatter } from "@/features/warehouse/quantity/warehouseQty";
import { useProductBaseUomLabels } from "@/features/warehouse/quantity/useProductBaseUomLabels";

export interface TaskHistoryEvent {
  id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  actor_id: string | null;
  device_id: string | null;
  scanned_barcode: string | null;
  lot_number: string | null;
  serial_number: string | null;
  quantity: number | null;
  quantity_delta: number | null;
  reason: string | null;
  occurred_at: string;
  source_loc: { code: string } | null;
  dest_loc: { code: string } | null;
}

const TONE: Record<string, "info" | "warning" | "success" | "neutral" | "danger"> = {
  "task.created": "neutral",
  "task.available": "neutral",
  "task.claimed": "info",
  "task.in_progress": "warning",
  "task.paused": "warning",
  "task.resumed": "warning",
  "task.completed": "success",
  "task.exception": "danger",
  "task.cancelled": "danger",
};

export function TaskHistorySheet({
  taskId,
  taskLabel,
  productId,
  onOpenChange,
}: {
  taskId: string | null;
  taskLabel?: string;
  /** The task's product — supplies the pack/base UoM vocabulary for quantities. */
  productId?: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  // Phase 2.4 — ledger quantities carry their unit, never a naked figure.
  const baseLabels = useProductBaseUomLabels([productId]);
  const qtyFmt = useWarehouseQtyFormatter([productId], baseLabels);
  const { data, isLoading } = useQuery({
    queryKey: ["wms-task-events", taskId],
    enabled: !!taskId,
    queryFn: async () => {
      const sel = (s: string): string => s;
      const { data, error } = await supabase
        .from("wms_task_events")
        .select(
          sel(
            "id, event_type, from_state, to_state, actor_id, device_id, scanned_barcode, lot_number, serial_number, quantity, quantity_delta, reason, occurred_at, source_loc:source_location_id(code), dest_loc:destination_location_id(code)",
          ),
        )
        .eq("task_id", taskId!)
        .order("occurred_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as TaskHistoryEvent[];
    },
  });

  return (
    <Sheet open={!!taskId} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> Execution history
          </SheetTitle>
          <SheetDescription>
            {taskLabel ? `${taskLabel} — ` : ""}every recorded action on this task, in order.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4">
          {isLoading ? (
            <LoadingState />
          ) : !data?.length ? (
            <EmptyState
              title="No recorded events"
              description="This task predates the execution ledger, or no transition has happened yet."
            />
          ) : (
            <ol className="relative space-y-4 border-l pl-5">
              {data.map((e) => (
                <li key={e.id} className="relative">
                  <span className="absolute -left-[1.4rem] top-1.5 h-2 w-2 rounded-full bg-border" />
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={TONE[e.event_type] ?? "neutral"}>
                      {e.event_type.replace("task.", "").replace("_", " ")}
                    </StatusBadge>
                    {e.from_state && e.to_state && (
                      <span className="text-xs text-muted-foreground">
                        {e.from_state} → {e.to_state}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {new Date(e.occurred_at).toLocaleString()}
                    </span>
                  </div>

                  <dl className="min-w-0 mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                    {e.actor_id && (
                      <Fact label="Actor" value={e.actor_id.slice(0, 8)} mono />
                    )}
                    {e.device_id && <Fact label="Device" value={e.device_id} mono />}
                    {e.source_loc?.code && <Fact label="From bin" value={e.source_loc.code} mono />}
                    {e.dest_loc?.code && <Fact label="To bin" value={e.dest_loc.code} mono />}
                    {e.scanned_barcode && <Fact label="Barcode" value={e.scanned_barcode} mono />}
                    {e.lot_number && <Fact label="Lot" value={e.lot_number} mono />}
                    {e.serial_number && <Fact label="Serial" value={e.serial_number} mono />}
                    {e.quantity != null && (
                      <Fact label="Quantity" value={qtyFmt.format(productId, e.quantity)} mono />
                    )}
                    {e.quantity_delta != null && (
                      <Fact label="Qty change" value={qtyFmt.formatSigned(productId, e.quantity_delta)} mono />
                    )}
                  </dl>

                  {e.reason && (
                    <p className="mt-1 text-xs text-muted-foreground italic">{e.reason}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono" : undefined}>{value}</dd>
    </div>
  );
}
