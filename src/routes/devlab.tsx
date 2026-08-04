/** TEMPORARY responsive lab — delete after audit. */
import { createFileRoute } from "@tanstack/react-router";
import { Section } from "@/design-system";
import {
  ArrivalLifecycleBoard, ArrivalWindowTimeline, InboundBottleneckRail,
  InboundDockStrip, InboundReadinessPanel,
} from "@/features/warehouse/inbound-tower";
import { HealthBanner, FlowSpine } from "@/features/warehouse/control-center";
import type { InboundArrival, InboundBottleneck, InboundDockBoard } from "@/features/warehouse/inbound-tower/contract";
import type { FlowStageHealth, FlowHealth } from "@/features/warehouse/control-center/contract";

export const Route = createFileRoute("/devlab")({ component: DevLab });

const stages: FlowStageHealth[] = [
  "receive", "inspect", "putaway", "store", "replenish", "pick", "pack", "load", "dispatch",
].map((s, i) => ({
  stage: s as FlowStageHealth["stage"],
  label: s[0].toUpperCase() + s.slice(1),
  backlog: 12 + i,
  in_progress: 3,
  oldest_age_seconds: 5400,
  sla_breached: i % 3,
  sla_at_risk: 2,
  blocked: 1,
  unassigned: 4,
  health: (["healthy", "degraded", "critical", "blocked"] as const)[i % 4],
  drill_route: "/warehouse-app/tasks",
})) as FlowStageHealth[];

const bottlenecks: InboundBottleneck[] = [
  { reason_code: "late_arrival", scope: "carrier_northbound_logistics", reason: "Northbound Logistics trailer NBL-88213 is 92 minutes past its booked window and has not reached the gate", severity: 90, impact_count: 240, route: "/warehouse-app/dock-schedule" },
  { reason_code: "putaway_backlog", scope: "zone_ambient_bulk_reserve", reason: "Put-away backlog in ambient bulk reserve exceeds the configured threshold", severity: 65, impact_count: 18, route: "/warehouse-app/putaway" },
];

const arrival: InboundArrival = {
  appointment_id: "a1", session_id: "s1", appointment_no: "APPT-2026-000188341",
  reference: "PO-99381-INTERNATIONAL-SUPPLY", appointment_state: "arrived", priority: 5,
  window_start: new Date().toISOString(), window_end: new Date().toISOString(),
  appointment_arrived_at: new Date().toISOString(), trailer_ref: "TRL-778812-REEFER",
  driver_name: "Immaculate Wanjiru", carrier_name: "Northbound Logistics International",
  visit_id: "v1", visit_status: "docked", visit_arrived_at: new Date().toISOString(),
  docked_at: new Date().toISOString(), dwell_minutes: 143, yard_slot_code: "Y-14",
  dock_id: "d1", dock_code: "DOCK-12", session_code: "RCV-1188", session_state: "in_progress",
  session_started_at: new Date().toISOString(), line_count: 48, captured_lines: 22,
  expected_qty: 1200, received_qty: 640, damaged_qty: 12, short_lines: 4, over_lines: 2,
  hold_lines: 1, unexpected_lines: 3, damaged_lines: 2, qc_pending: 5, crossdock_pending: 2,
  putaway_open: 7, putaway_done: 3, exception_count: 4, exception_breached: 1,
  lifecycle_stage: "capture", minutes_to_window: -92, risk: "breached",
  drill_route: "/warehouse-app/receiving", receive_pct: 53,
};

const dockBoard = {
  docks: Array.from({ length: 6 }, (_, i) => ({
    dock_id: `d${i}`, code: `INBOUND-DOCK-${i + 1}`, name: `Ambient receiving door ${i + 1}`,
    dock_type: "inbound", open_sessions: i % 2, visit_id: null,
    trailer_ref: "TRL-778812-REEFER-INTERNATIONAL", docked_at: null,
    next_window_at: new Date().toISOString(), occupied: i % 2 === 0,
  })),
  waiting_trailers: [
    { visit_id: "w1", trailer_ref: "TRL-99120-CONTAINER-LONG-NAME", status: "waiting", arrived_at: null, waiting_minutes: 180, yard_slot_id: null },
  ],
  yard_slots: { total: 20, free: 6 },
} as unknown as InboundDockBoard;

function DevLab() {
  return (
    <div className="@container/page mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 lg:px-8">
      <div className="space-y-6">
        <HealthBanner health={{ overall: "critical", reason: "Two docks blocked", stages } as unknown as FlowHealth} />
        <Section title="Inbound flow"><FlowSpine stages={stages} /></Section>
        <div className="grid gap-6 @4xl/page:grid-cols-3">
          <div className="space-y-6 @4xl/page:col-span-2">
            <Section title="Blockers" description="Ranked by severity.">
              <InboundBottleneckRail bottlenecks={bottlenecks} />
            </Section>
            <Section title="Arrivals">
              <ArrivalLifecycleBoard arrivals={[arrival, { ...arrival, appointment_id: "a2", risk: "at_risk" }]} />
            </Section>
          </div>
          <div className="space-y-6">
            <Section title="Docks and yard"><InboundDockStrip board={dockBoard} /></Section>
            <Section title="Arrival clock"><ArrivalWindowTimeline arrivals={[arrival]} /></Section>
            <Section title="Downstream readiness"><InboundReadinessPanel stages={stages} /></Section>
          </div>
        </div>
      </div>
    </div>
  );
}
