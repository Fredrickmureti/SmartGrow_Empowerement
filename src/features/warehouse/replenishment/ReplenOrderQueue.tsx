/**
 * Live replenishment work queue (ADR 0108).
 *
 * The supervisor's decision surface: every open order with its rule scope,
 * pick face, source, age vs SLA and state, plus bulk approve / dispatch /
 * cancel. All writes go through `wms_transition_replen_order`.
 */
import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { StatusBadge, EmptyState, LoadingState } from "@/design-system";
import { Waves, Info } from "lucide-react";
import { ReplenDecisionDrawer } from "./ReplenDecisionDrawer";
import {
  useTransitionReplenOrder,
  type ReplenOrderRow,
  type ReplenOrderState,
} from "./useReplenOrders";

const TONE: Record<string, "neutral" | "info" | "warning" | "success" | "danger"> = {
  planned: "neutral",
  approved: "info",
  dispatched: "info",
  in_progress: "warning",
  completed: "success",
  short: "warning",
  cancelled: "danger",
};

function ageLabel(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

interface Props {
  orders: ReplenOrderRow[];
  isLoading: boolean;
  slaMinutes?: number;
}

export function ReplenOrderQueue({ orders, isLoading, slaMinutes = 60 }: Props) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [traceOrder, setTraceOrder] = useState<ReplenOrderRow | null>(null);
  const transition = useTransitionReplenOrder();

  const chosen = useMemo(
    () => orders.filter((o) => selected[o.id]),
    [orders, selected],
  );

  const run = (to: ReplenOrderState, reason?: string) => {
    if (chosen.length === 0) return;
    transition.mutate(
      { orders: chosen, to, reason },
      { onSuccess: () => setSelected({}) },
    );
  };

  if (isLoading) return <LoadingState />;
  if (orders.length === 0) {
    return (
      <EmptyState
        icon={Waves}
        title="Nothing to replenish"
        description="Every pick face is above its effective threshold."
      />
    );
  }

  const allChecked = orders.length > 0 && orders.every((o) => selected[o.id]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {chosen.length > 0 ? `${chosen.length} selected` : `${orders.length} open`}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!chosen.length || transition.isPending} onClick={() => run("approved")}>
            Approve
          </Button>
          <Button size="sm" disabled={!chosen.length || transition.isPending} onClick={() => run("dispatched")}>
            Dispatch
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!chosen.length || transition.isPending}
            onClick={() => run("cancelled", "Cancelled by supervisor")}
          >
            Cancel
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-muted/60 text-muted-foreground backdrop-blur">
                <tr>
                  <th className="p-3 text-left">
                    <Checkbox
                      checked={allChecked}
                      onCheckedChange={(v) =>
                        setSelected(v ? Object.fromEntries(orders.map((o) => [o.id, true])) : {})
                      }
                      aria-label="Select all orders"
                    />
                  </th>
                  <th className="p-3 text-left">Product</th>
                  <th className="p-3 text-left">Rule</th>
                  <th className="p-3 text-left">Pick face</th>
                  <th className="p-3 text-left">Source</th>
                  <th className="p-3 text-right">Qty</th>
                  <th className="p-3 text-right">Priority</th>
                  <th className="p-3 text-right">Age</th>
                  <th className="p-3 text-left">State</th>
                  <th className="p-3 text-right">Why</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const overdue = (Date.now() - new Date(o.created_at).getTime()) / 60000 > slaMinutes;
                  return (
                    <tr key={o.id} className="border-t">
                      <td className="p-3">
                        <Checkbox
                          checked={!!selected[o.id]}
                          onCheckedChange={(v) => setSelected((s) => ({ ...s, [o.id]: !!v }))}
                          aria-label={`Select order for ${o.product?.name ?? "product"}`}
                        />
                      </td>
                      <td className="p-3">
                        <div className="font-medium">{o.product?.name ?? "—"}</div>
                        {o.product?.sku && <div className="text-xs text-muted-foreground">{o.product.sku}</div>}
                      </td>
                      <td className="p-3">
                        <Badge variant="secondary">{o.rule?.scope ?? "ad-hoc"}</Badge>
                      </td>
                      <td className="p-3 font-mono text-xs">{o.pick_loc?.code ?? "—"}</td>
                      <td className="p-3 font-mono text-xs">
                        {o.source_loc?.code ?? <span className="text-muted-foreground">auto</span>}
                        {o.lot_number ? <div className="text-muted-foreground">lot {o.lot_number}</div> : null}
                      </td>
                      <td className="p-3 text-right">{o.requested_qty}</td>
                      <td className="p-3 text-right">{o.priority}</td>
                      <td className={`p-3 text-right ${overdue ? "text-destructive font-medium" : ""}`}>
                        {ageLabel(o.created_at)}
                      </td>
                      <td className="p-3">
                        <StatusBadge tone={TONE[o.state] ?? "neutral"}>{o.state}</StatusBadge>
                      </td>
                      <td className="p-3 text-right">
                        <Button size="sm" variant="ghost" onClick={() => setTraceOrder(o)} aria-label="Show decision trace">
                          <Info className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <ReplenDecisionDrawer order={traceOrder} onOpenChange={(v) => !v && setTraceOrder(null)} />
    </>
  );
}
