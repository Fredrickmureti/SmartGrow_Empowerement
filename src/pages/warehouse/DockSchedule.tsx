/**
 * DockSchedule — Dock Scheduling Command Centre (ADR 0080 Phase E).
 *
 * A live resource-timeline board: one lane per dock, appointments placed on
 * real time, drag-to-reschedule, downtime hatching, now-line, KPI strip and
 * a yard/live-visit rail. Every write is an RPC; the page never inserts or
 * updates `wms_dock_appointments` directly.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, PageBody, Section, LoadingState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  CalendarClock,
  Plus,
  Truck,
  Timer,
  AlertTriangle,
  Gauge,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  APPOINTMENT_STATE_LABEL,
  hhmm,
  localDay,
  minutesBetween,
  type AppointmentRow,
} from "@/features/warehouse/dock/dockScheduling";
import {
  useDayAppointments,
  useDayDowntime,
  useDocks,
  useLiveVisits,
  useRescheduleAppointment,
  useWarehouses,
} from "@/features/warehouse/dock/useDockScheduling";
import { DockTimeline } from "@/features/warehouse/dock/DockTimeline";
import { AppointmentDrawer } from "@/features/warehouse/dock/AppointmentDrawer";

type ViewMode = "timeline" | "list";

function shiftDay(day: string, delta: number) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return localDay(d);
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

export default function DockSchedule() {
  const [warehouseId, setWarehouseId] = useState("");
  const [day, setDay] = useState(localDay());
  const [view, setView] = useState<ViewMode>("timeline");
  const [selected, setSelected] = useState<AppointmentRow | null>(null);

  const { data: warehouses } = useWarehouses();
  const { data: docks, isLoading: docksLoading } = useDocks(warehouseId);
  const { data: appointments, isLoading } = useDayAppointments(warehouseId, day);
  const { data: downtime } = useDayDowntime(warehouseId, day);
  const { data: visits } = useLiveVisits(warehouseId);
  const reschedule = useRescheduleAppointment();

  const dockById = useMemo(
    () => new Map((docks ?? []).map((d) => [d.id, d])),
    [docks],
  );

  const kpis = useMemo(() => {
    const list = appointments ?? [];
    const live = list.filter((a) => a.state !== "cancelled");
    const completed = list.filter((a) => a.state === "completed");
    const onTime = completed.filter(
      (a) => a.arrived_at && new Date(a.arrived_at).getTime() <= new Date(a.window_end).getTime(),
    ).length;
    const late = live.filter(
      (a) => a.state === "scheduled" && new Date(a.window_end).getTime() < Date.now(),
    ).length;
    const bookedMinutes = live.reduce((s, a) => s + minutesBetween(a.window_start, a.window_end), 0);
    const capacityMinutes = (docks ?? []).length * 18 * 60; // 05:00–23:00 board window
    const utilisation = capacityMinutes > 0 ? Math.round((bookedMinutes / capacityMinutes) * 100) : 0;
    const dwell = (visits ?? [])
      .filter((v) => v.arrived_at)
      .map((v) => Math.round((Date.now() - new Date(v.arrived_at as string).getTime()) / 60000));
    const avgDwell = dwell.length ? Math.round(dwell.reduce((a, b) => a + b, 0) / dwell.length) : 0;
    return {
      total: live.length,
      onSite: (visits ?? []).length,
      onTimePct: completed.length ? Math.round((onTime / completed.length) * 100) : null,
      late,
      utilisation,
      avgDwell,
    };
  }, [appointments, docks, visits]);

  function handleMove({
    appointment,
    dockId,
    deltaMinutes,
  }: {
    appointment: AppointmentRow;
    dockId: string;
    deltaMinutes: number;
  }) {
    const ws = new Date(new Date(appointment.window_start).getTime() + deltaMinutes * 60000);
    const we = new Date(new Date(appointment.window_end).getTime() + deltaMinutes * 60000);
    reschedule.mutate({
      appointmentId: appointment.id,
      dockId,
      windowStart: ws.toISOString(),
      windowEnd: we.toISOString(),
    });
  }

  return (
    <>
      <PageHeader
        title="Dock scheduling command centre"
        description="Live dock capacity, appointment timeline and trailers on site. Moves are validated against dock capability, downtime and collisions."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/warehouse-app/yard">
                <Truck className="h-4 w-4 mr-2" /> Yard board
              </Link>
            </Button>
            <Button asChild disabled={!warehouseId}>
              <Link to={`/warehouse-app/schedule/new${warehouseId ? `?warehouse=${warehouseId}` : ""}`}>
                <Plus className="h-4 w-4 mr-2" /> Schedule appointment
              </Link>
            </Button>
          </div>
        }
      />
      <PageBody>
        <Section>
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Warehouse</label>
              <select
                className="h-9 w-full min-w-0 sm:w-56 rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
              >
                <option value="" className="bg-background text-foreground">Select…</option>
                {(warehouses ?? []).map((w) => (
                  <option key={w.id} value={w.id} className="bg-background text-foreground">{w.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Date</label>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" className="h-9 w-9 p-0" aria-label="Previous day"
                  onClick={() => setDay((d) => shiftDay(d, -1))}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-auto" />
                <Button size="sm" variant="outline" className="h-9 w-9 p-0" aria-label="Next day"
                  onClick={() => setDay((d) => shiftDay(d, 1))}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDay(localDay())}>Today</Button>
              </div>
            </div>
            <div className="ml-auto flex gap-1">
              <Button size="sm" variant={view === "timeline" ? "default" : "outline"}
                onClick={() => setView("timeline")}>Timeline</Button>
              <Button size="sm" variant={view === "list" ? "default" : "outline"}
                onClick={() => setView("list")}>List</Button>
            </div>
          </div>
        </Section>

        {!warehouseId ? (
          <Section>
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <CalendarClock className="h-4 w-4" /> Pick a warehouse to open its dock board.
            </div>
          </Section>
        ) : isLoading || docksLoading ? (
          <LoadingState />
        ) : (docks ?? []).length === 0 ? (
          <Section>
            <div className="text-sm text-muted-foreground">
              No docks configured for this warehouse yet.
            </div>
          </Section>
        ) : (
          <>
            <Section>
              <div className="min-w-0 grid gap-3 @xl/page:grid-cols-2 @4xl/page:grid-cols-5">
                <Kpi icon={CalendarClock} label="Appointments today" value={String(kpis.total)} />
                <Kpi icon={Truck} label="Trailers on site" value={String(kpis.onSite)} />
                <Kpi
                  icon={Gauge}
                  label="Dock utilisation"
                  value={`${kpis.utilisation}%`}
                  hint={`${(docks ?? []).length} active docks`}
                />
                <Kpi
                  icon={Timer}
                  label="Avg dwell (on site)"
                  value={kpis.avgDwell ? `${kpis.avgDwell}m` : "—"}
                />
                <Kpi
                  icon={AlertTriangle}
                  label="Overdue arrivals"
                  value={String(kpis.late)}
                  tone={kpis.late > 0 ? "text-destructive" : undefined}
                  hint={kpis.onTimePct !== null ? `${kpis.onTimePct}% on time` : undefined}
                />
              </div>
            </Section>

            {view === "timeline" ? (
              <Section title={`Dock board — ${day}`}>
                <DockTimeline
                  day={day}
                  docks={docks ?? []}
                  appointments={appointments ?? []}
                  downtime={downtime ?? []}
                  selectedId={selected?.id ?? null}
                  onSelect={(a) => setSelected(a)}
                  onMove={handleMove}
                />
              </Section>
            ) : (
              <Section title={`Appointments — ${day}`} contentClassName="px-0 pb-0">
                <div className="divide-y">
                  {(appointments ?? []).length === 0 ? (
                    <div className="p-6 text-sm text-muted-foreground">No appointments booked.</div>
                  ) : (
                    (appointments ?? []).map((a) => (
                      <button
                        key={a.id}
                        onClick={() => setSelected(a)}
                        className="w-full text-left p-3 flex flex-wrap items-center gap-2 hover:bg-muted/40"
                      >
                        <span className="font-mono text-xs">{a.appointment_no ?? "—"}</span>
                        <Badge variant="outline">{a.appointment_type}</Badge>
                        <span className="text-sm">
                          {dockById.get(a.dock_id)?.code ?? "—"} · {hhmm(a.window_start)}–{hhmm(a.window_end)}
                        </span>
                        {a.trailer_ref && (
                          <span className="text-xs text-muted-foreground">{a.trailer_ref}</span>
                        )}
                        <Badge variant="secondary" className="ml-auto">
                          {APPOINTMENT_STATE_LABEL[a.state]}
                        </Badge>
                      </button>
                    ))
                  )}
                </div>
              </Section>
            )}

            <Section title="On site now" contentClassName="px-0 pb-0">
              <div className="divide-y">
                {(visits ?? []).length === 0 ? (
                  <div className="p-6 text-sm text-muted-foreground">No trailers on site.</div>
                ) : (
                  (visits ?? []).map((v) => (
                    <div key={v.id} className="p-3 flex flex-wrap items-center gap-2 text-sm">
                      <Truck className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{v.trailer_ref}</span>
                      <Badge variant="outline">{v.status.replace(/_/g, " ")}</Badge>
                      {v.driver_name && <span className="text-muted-foreground">{v.driver_name}</span>}
                      {v.dock_id && (
                        <span className="text-xs text-muted-foreground">
                          at {dockById.get(v.dock_id)?.code ?? "dock"}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        in yard since {hhmm(v.arrived_at)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </Section>
          </>
        )}
      </PageBody>

      <AppointmentDrawer
        appointment={selected}
        dock={selected ? dockById.get(selected.dock_id) : undefined}
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
      />
    </>
  );
}
