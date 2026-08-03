/**
 * Supervisor KPI strip for the replenishment control centre (ADR 0108).
 * Pure presentation over the open-order set — no queries of its own.
 */
import { Card, CardContent } from "@/components/ui/card";
import type { ReplenOrderRow } from "./useReplenOrders";

interface Props {
  orders: ReplenOrderRow[];
  slaMinutes?: number;
}

function ageMinutes(iso: string) {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

export function ReplenKpiStrip({ orders, slaMinutes = 60 }: Props) {
  const open = orders.length;
  const awaiting = orders.filter((o) => o.state === "planned").length;
  const inFlight = orders.filter((o) => o.state === "dispatched" || o.state === "in_progress").length;
  const overdue = orders.filter((o) => ageMinutes(o.created_at) > slaMinutes).length;
  const units = orders.reduce((s, o) => s + Number(o.requested_qty || 0), 0);

  const tiles = [
    { label: "Open orders", value: open, hint: "Planned through in-progress" },
    { label: "Awaiting approval", value: awaiting, hint: "Not yet dispatched" },
    { label: "In flight", value: inFlight, hint: "Operator has the work" },
    { label: "Past SLA", value: overdue, hint: `Older than ${slaMinutes} min`, danger: overdue > 0 },
    { label: "Units queued", value: units, hint: "Requested base units" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {tiles.map((t) => (
        <Card key={t.label}>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</div>
            <div className={`mt-1 text-2xl font-semibold ${t.danger ? "text-destructive" : ""}`}>{t.value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t.hint}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
