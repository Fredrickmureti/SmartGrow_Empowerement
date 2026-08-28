/**
 * Yard KPI strip — the six numbers a yard supervisor is accountable for.
 * Pure presentation; every value is derived in `deriveYardKpis`.
 */
import { SummaryStatCard, SummaryStatGrid } from "@/design-system";
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

export function YardKpiStrip({ kpis, loading = false }: { kpis: YardKpis; loading?: boolean }) {
  const occupancy = kpis.slotsTotal
    ? Math.round(((kpis.slotsTotal - kpis.slotsFree) / kpis.slotsTotal) * 100)
    : 0;
  return (
    <SummaryStatGrid>
      <SummaryStatCard
        icon={<Truck className="h-3.5 w-3.5" />}
        label="On site"
        value={kpis.onSite}
        footer={`${kpis.atGate} at gate`}
        loading={loading}
        to="/warehouse-app/yard"
      />
      <SummaryStatCard
        icon={<DoorOpen className="h-3.5 w-3.5" />}
        label="At dock"
        value={kpis.atDock}
        footer={`${kpis.inYard} waiting in yard`}
        loading={loading}
        to="/warehouse-app/yard/marshal"
      />
      <SummaryStatCard
        icon={<Timer className="h-3.5 w-3.5" />}
        label="Average dwell"
        value={formatDwell(kpis.avgDwell)}
        footer={`worst ${formatDwell(kpis.worstDwell)}`}
        tone={kpis.avgDwell >= 120 ? "orange" : "neutral"}
        loading={loading}
      />
      <SummaryStatCard
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
        label="Past window"
        value={kpis.overdue}
        footer="appointment window closed"
        tone={kpis.overdue > 0 ? "bad" : "neutral"}
        accent={kpis.overdue > 0}
        loading={loading}
        to="/warehouse-app/yard?filter=overdue"
      />
      <SummaryStatCard
        icon={<ParkingSquare className="h-3.5 w-3.5" />}
        label="Yard occupancy"
        value={`${occupancy}%`}
        footer={`${kpis.slotsFree} of ${kpis.slotsTotal} slots free`}
        tone={occupancy >= 90 ? "bad" : occupancy >= 75 ? "warn" : "neutral"}
        loading={loading}
      />
      <SummaryStatCard
        icon={<CheckCircle2 className="h-3.5 w-3.5" />}
        label="Cleared to leave"
        value={kpis.clearedToLeave}
        footer="awaiting gate exit"
        loading={loading}
        to="/warehouse-app/yard/gate"
      />
    </SummaryStatGrid>
  );
}
