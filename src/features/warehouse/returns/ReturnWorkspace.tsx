/**
 * ReturnWorkspace — the split-pane execution surface for one return order
 * (Returns audit, Phase 4).
 *
 * The header FSM, the lines, the posting gate and the event trail live in one
 * pane so an operator never has to reason across screens. Posting inventory
 * effects is a single sanctioned call (`wms_post_return_dispositions`), and the
 * close action is server-guarded: unposted lines cannot be closed away.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/design-system";
import { Check, FileText, PackageCheck, Play, Receipt, Truck, XCircle } from "lucide-react";
import { OutboxTimeline } from "@/features/warehouse/events/OutboxTimeline";
import { ReturnLinesPanel } from "./ReturnLinesPanel";
import { useReturnLines, usePostReturnDispositions } from "./useReturnLines";
import { useCloseReturn, useCreateReturnFinanceDoc, useTransitionReturn } from "./useReturnOrders";
import { dispatchReturnDocument } from "./dispatchReturnDocument";
import type { ReturnDocumentKind } from "@/services/documents/snapshots/wmsReturn";
import {
  RETURN_LANE_LABEL,
  RETURN_STATE_TONE,
  returnLane,
  type ReturnOrder,
  type ReturnState,
} from "./returnsModel";

export interface ReturnWorkspaceProps {
  order: ReturnOrder | null;
  onClose: () => void;
}

function label(value: string | null | undefined): string {
  return value ? value.replace(/_/g, " ") : "—";
}

export function ReturnWorkspace({ order, onClose }: ReturnWorkspaceProps) {
  const { data: lines } = useReturnLines(order?.id);
  const transition = useTransitionReturn();
  const post = usePostReturnDispositions();
  const close = useCloseReturn();
  const raiseFinanceDoc = useCreateReturnFinanceDoc();
  const [dispatching, setDispatching] = useState<ReturnDocumentKind | null>(null);

  const rows = lines ?? [];
  const lane = order ? returnLane(order, rows) : null;

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, l) => ({
        received: acc.received + Number(l.received_qty ?? 0),
        restock: acc.restock + Number(l.restock_qty ?? 0),
        quarantine: acc.quarantine + Number(l.quarantine_qty ?? 0),
        scrap: acc.scrap + Number(l.scrap_qty ?? 0),
        pendingDisposition: acc.pendingDisposition + (l.disposition ? 0 : 1),
        unposted: acc.unposted + (l.disposition && !l.posted_at ? 1 : 0),
        damaged:
          acc.damaged +
          (l.condition_code === "damaged" ||
          l.condition_code === "defective" ||
          l.condition_code === "expired"
            ? 1
            : 0),
      }),
      {
        received: 0, restock: 0, quarantine: 0, scrap: 0,
        pendingDisposition: 0, unposted: 0, damaged: 0,
      },
    );
  }, [rows]);

  const emitDocument = async (kind: ReturnDocumentKind, source: "manual" | "business_event" = "manual") => {
    if (!order) return;
    setDispatching(kind);
    try {
      await dispatchReturnDocument({ returnId: order.id, kind, triggeredSource: source });
      toast.success("Document archived and routed");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Document dispatch failed");
    } finally {
      setDispatching(null);
    }
  };

  if (!order) return null;

  const terminal = order.state === "closed" || order.state === "cancelled";

  const run = (to: ReturnState, reason?: string) =>
    transition.mutate(
      { returnId: order.id, toState: to, rowVersion: order.row_version, reason },
      {
        onSuccess: () => toast.success(`Return ${label(to)}`),
        onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Transition rejected"),
      },
    );

  const headerActions = (() => {
    switch (order.state) {
      case "draft":
        return [{ label: "Authorize", icon: Check, run: () => run("authorized") }];
      case "authorized":
        return [
          { label: "In transit", icon: Truck, run: () => run("in_transit") },
          { label: "Mark received", icon: Play, run: () => run("received") },
        ];
      case "in_transit":
        return [{ label: "Mark received", icon: Play, run: () => run("received") }];
      case "received":
        return [{ label: "Start inspection", icon: Play, run: () => run("inspecting") }];
      default:
        return [];
    }
  })();

  const canPost =
    (order.state === "inspecting" || order.state === "received") &&
    rows.length > 0 &&
    totals.pendingDisposition === 0 &&
    totals.unposted > 0;

  const canClose = order.state === "disposed" && totals.unposted === 0;

  return (
    <Sheet open={!!order} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="font-mono">{order.code}</span>
            <StatusBadge tone={RETURN_STATE_TONE[order.state]}>{label(order.state)}</StatusBadge>
            {lane && <span className="text-xs text-muted-foreground">{RETURN_LANE_LABEL[lane]}</span>}
          </SheetTitle>
          <SheetDescription>
            {label(order.return_kind)} return
            {order.rma_reference ? ` · RMA ${order.rma_reference}` : ""}
            {order.tracking_reference ? ` · tracking ${order.tracking_reference}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-4 gap-2 text-sm">
            {[
              ["Received", totals.received],
              ["Restock", totals.restock],
              ["Quarantine", totals.quarantine],
              ["Scrap", totals.scrap],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-md border p-2">
                <div className="text-lg font-semibold tabular-nums">{Number(v)}</div>
                <div className="text-xs text-muted-foreground">{String(k)}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {headerActions.map((a) => (
              <Button key={a.label} size="sm" variant="outline" onClick={a.run} disabled={transition.isPending}>
                <a.icon className="mr-1.5 h-3.5 w-3.5" />{a.label}
              </Button>
            ))}
            <Button
              size="sm"
              disabled={!canPost || post.isPending}
              onClick={() =>
                post.mutate(
                  { returnId: order.id, rowVersion: order.row_version },
                  {
                    onSuccess: (res) => {
                      toast.success(
                        `Posted ${res.posted_lines} line(s) · ${res.tasks_created} task(s) created`,
                      );
                      // Posting is the moment the return becomes a fact of
                      // record, so the return receipt is archived as a
                      // business event — best effort, never blocking the post.
                      void emitDocument("wms.return_receipt", "business_event");
                    },
                    onError: (e: unknown) =>
                      toast.error(e instanceof Error ? e.message : "Posting rejected"),
                  },
                )
              }
            >
              <PackageCheck className="mr-1.5 h-3.5 w-3.5" /> Post dispositions
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canClose || close.isPending}
              onClick={() =>
                close.mutate(
                  { returnId: order.id, rowVersion: order.row_version },
                  {
                    onSuccess: () => toast.success("Return closed"),
                    onError: (e: unknown) =>
                      toast.error(e instanceof Error ? e.message : "Close rejected"),
                  },
                )
              }
            >
              <Check className="mr-1.5 h-3.5 w-3.5" /> Close
            </Button>
            {!terminal && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => run("cancelled", "Cancelled from workspace")}
                disabled={transition.isPending}
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" /> Cancel return
              </Button>
            )}
          </div>

          {totals.pendingDisposition > 0 && (
            <p className="text-xs text-muted-foreground">
              {totals.pendingDisposition} line(s) still need a disposition before stock can post.
            </p>
          )}

          <Separator />
          <ReturnLinesPanel order={order} readOnly={terminal} />

          <Separator />
          <div>
            <div className="mb-2 text-sm font-medium">Event trail</div>
            <OutboxTimeline aggregateId={order.id} compact />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
