/**
 * Yard KPI strip — the six numbers a yard supervisor is accountable for.
 * Pure presentation; every value is derived in `deriveYardKpis`.
 */
import { Card, CardContent } from "@/components/ui/card";
import { Truck, ParkingSquare, Timer, AlertTriangle, DoorOpen, CheckCircle2 } from "lucide-react";
import {
  dwellMinutes,
  formatDwell,
  isOnSite,
  isOverdue,
  type VisitRow,
  type YardSlotRow,
} from "./yardModel";

export interface YardKpis {
  onSite: number;
  atDock: number;
  inYard: number;
  atGate: number;
  avgDwell: number;
  worstDwell: number;
  overdue: number;
  slotsFree: number;
  slotsTotal: number;
  clearedToLeave: number;
}

export function deriveYardKpis(visits: VisitRow[], slots: YardSlotRow[]): YardKpis {
  const live = visits.filter(isOnSite);
  const dwells = live.map(dwellMinutes);
  return {
    onSite: live.length,
    atDock: live.filter((v) => v.status === "at_dock").length,
    inYard: live.filter((v) => v.status === "in_yard").length,
    atGate: live.filter((v) => v.status === "arrived").length,
    avgDwell: dwells.length ? Math.round(dwells.reduce((a, b) => a + b, 0) / dwells.length) : 0,
    worstDwell: dwells.length ? Math.max(...dwells) : 0,
    overdue: live.filter(isOverdue).length,
    slotsFree: slots.filter((s) => s.status === "available").length,
    slotsTotal: slots.length,
    clearedToLeave: live.filter((v) => v.departure_approved_at).length,
  };
}

function Kpi({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className="h-3.5 w-3.5" /> {label}
        </div>
        <div className={`text-2xl font-semibold mt-1 ${tone ?? ""}`}>{value}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </CardContent>
    </Card>
  );
}

export function YardKpiStrip({ kpis }: { kpis: YardKpis }) {
  const occupancy = kpis.slotsTotal
    ? Math.round(((kpis.slotsTotal - kpis.slotsFree) / kpis.slotsTotal) * 100)
    : 0;
  return (
    <div className="grid gap-3 @xl/page:grid-cols-2 @4xl/page:grid-cols-3 @5xl/page:grid-cols-6">
      <Kpi icon={Truck} label="On site" value={String(kpis.onSite)} hint={`${kpis.atGate} at gate`} />
      <Kpi icon={DoorOpen} label="At dock" value={String(kpis.atDock)} hint={`${kpis.inYard} waiting in yard`} />
      <Kpi
        icon={Timer}
        label="Average dwell"
        value={formatDwell(kpis.avgDwell)}
        hint={`worst ${formatDwell(kpis.worstDwell)}`}
        tone={kpis.avgDwell >= 120 ? "text-orange-600 dark:text-orange-400" : undefined}
      />
      <Kpi
        icon={AlertTriangle}
        label="Past window"
        value={String(kpis.overdue)}
        hint="appointment window closed"
        tone={kpis.overdue > 0 ? "text-destructive" : undefined}
      />
      <Kpi
        icon={ParkingSquare}
        label="Yard occupancy"
        value={`${occupancy}%`}
        hint={`${kpis.slotsFree} of ${kpis.slotsTotal} slots free`}
        tone={occupancy >= 90 ? "text-destructive" : occupancy >= 75 ? "text-amber-600 dark:text-amber-400" : undefined}
      />
      <Kpi icon={CheckCircle2} label="Cleared to leave" value={String(kpis.clearedToLeave)} hint="awaiting gate exit" />
    </div>
  );
}
