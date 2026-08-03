/**
 * Decision trace drawer (ADR 0108).
 *
 * Every replenishment order carries the inputs the engine used, the rule it
 * matched, and the source candidates it rejected. This drawer renders that
 * trace so a supervisor can answer "why this order, why this source?".
 */
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import type { ReplenOrderRow } from "./useReplenOrders";

interface Props {
  order: ReplenOrderRow | null;
  onOpenChange: (open: boolean) => void;
}

type Trace = {
  reason_code?: string;
  rule_scope?: string;
  strategy?: string;
  projected?: number;
  min_qty?: number;
  target_qty?: number;
  raw_qty?: number;
  on_hand?: number;
  allocated?: number;
  blocked?: number;
  inbound?: number;
  rejected_sources?: Array<{ location_code?: string; location_id?: string; reason?: string }>;
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value ?? "—"}</span>
    </div>
  );
}

export function ReplenDecisionDrawer({ order, onOpenChange }: Props) {
  const trace = (order?.decision_trace ?? {}) as Trace;
  const rejected = trace.rejected_sources ?? [];

  return (
    <Sheet open={!!order} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Decision trace</SheetTitle>
          <SheetDescription>
            {order?.product?.name ?? "—"} → <span className="font-mono">{order?.pick_loc?.code ?? "—"}</span>
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-6">
          <div>
            <div className="mb-2 flex flex-wrap gap-2">
              <Badge variant="secondary">{trace.rule_scope ?? order?.rule?.scope ?? "no rule"}</Badge>
              <Badge variant="outline">{trace.strategy ?? order?.rule?.strategy ?? "—"}</Badge>
              <Badge>{trace.reason_code ?? order?.reason_code ?? "—"}</Badge>
            </div>
            <Row label="Projected position" value={trace.projected} />
            <Row label="On hand" value={trace.on_hand} />
            <Row label="Allocated to waves" value={trace.allocated} />
            <Row label="Blocked / expired" value={trace.blocked} />
            <Row label="Already inbound" value={trace.inbound} />
          </div>

          <div>
            <h4 className="mb-1 text-sm font-semibold">Quantity</h4>
            <Row label="Min" value={trace.min_qty} />
            <Row label="Target" value={trace.target_qty} />
            <Row label="Raw need" value={trace.raw_qty} />
            <Row label="Requested" value={order?.requested_qty} />
            <Row label="Moved so far" value={order?.moved_qty} />
          </div>

          <div>
            <h4 className="mb-1 text-sm font-semibold">Source</h4>
            <Row label="Chosen" value={<span className="font-mono">{order?.source_loc?.code ?? "auto"}</span>} />
            <Row label="Lot" value={order?.lot_number} />
            {rejected.length === 0 ? (
              <p className="pt-2 text-xs text-muted-foreground">No alternative sources were rejected.</p>
            ) : (
              <ul className="pt-2 space-y-1 text-xs text-muted-foreground">
                {rejected.map((r, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="font-mono">{r.location_code ?? r.location_id}</span>
                    <span>{r.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {order && (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">Raw trace</summary>
              <pre className="mt-2 overflow-x-auto text-[11px]">{JSON.stringify(order.decision_trace, null, 2)}</pre>
            </details>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
