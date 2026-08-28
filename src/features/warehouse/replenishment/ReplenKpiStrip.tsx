/**
 * Supervisor KPI strip for the replenishment control centre (ADR 0108).
 * Pure presentation over the open-order set — no queries of its own.
 */
import { SummaryStatCard, SummaryStatGrid } from "@/design-system";
import { AlertTriangle, Boxes, Clock, ListChecks, Truck } from "lucide-react";
import type { ReplenOrderRow } from "./useReplenOrders";

interface Props {
  orders: ReplenOrderRow[];
  slaMinutes?: number;
  loading?: boolean;
}

function ageMinutes(iso: string) {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

export function ReplenKpiStrip({ orders, slaMinutes = 60, loading = false }: Props) {
  const open = orders.length;
  const awaiting = orders.filter((o) => o.state === "planned").length;
  const inFlight = orders.filter((o) => o.state === "dispatched" || o.state === "in_progress").length;
  const overdue = orders.filter((o) => ageMinutes(o.created_at) > slaMinutes).length;
  const units = orders.reduce((s, o) => s + Number(o.requested_qty || 0), 0);

  return (
    <SummaryStatGrid>
      <SummaryStatCard
        label="Open orders"
        value={open}
        footer="Planned through in-progress"
        icon={<ListChecks className="h-3.5 w-3.5" />}
        loading={loading}
        to="/warehouse-app/replenishment"
      />
      <SummaryStatCard
        label="Awaiting approval"
        value={awaiting}
        footer="Not yet dispatched"
        icon={<Clock className="h-3.5 w-3.5" />}
        tone={awaiting > 0 ? "warn" : "neutral"}
        loading={loading}
        to="/warehouse-app/replenishment?state=planned"
      />
      <SummaryStatCard
        label="In flight"
        value={inFlight}
        footer="Operator has the work"
        icon={<Truck className="h-3.5 w-3.5" />}
        loading={loading}
        to="/warehouse-app/replenishment?state=in_progress"
      />
      <SummaryStatCard
        label="Past SLA"
        value={overdue}
        footer={`Older than ${slaMinutes} min`}
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
        tone={overdue > 0 ? "bad" : "ok"}
        accent={overdue > 0}
        loading={loading}
        to="/warehouse-app/replenishment?sla=breached"
      />
      <SummaryStatCard
        label="Units queued"
        value={units}
        footer="Requested base units"
        icon={<Boxes className="h-3.5 w-3.5" />}
        loading={loading}
      />
    </SummaryStatGrid>
  );
}
