/**
 * ReceivingSessionBoard — Receiving audit, Phase 5b.
 *
 * A dock supervisor does not read a table; they look at doors. This board
 * renders one lane per session state with a card per truck carrying the
 * facts that decide what to do next: dock and appointment window, supervisor
 * of record, source document, live received/expected progress and the
 * variance chips that block posting.
 *
 * Presentational only — every mutation is still owned by the page
 * (`wms_transition_receiving`) or the workspace (`wms_post_receiving_session`).
 */
import { StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ActivityHistoryButton } from "@/features/warehouse/events/ActivitySection";
import { CalendarClock, DoorOpen, FileText, ShieldCheck, Timer, Truck, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { dwellMinutes, type TrailerVisitInfo } from "./useReceivingTrailerVisits";

export type RcvState =
  | "open" | "unloading" | "captured" | "discrepant" | "posted" | "closed" | "cancelled";

export interface BoardSession {
  id: string;
  code: string;
  state: RcvState;
  source_doc_type: string | null;
  appointment_id: string | null;
  dock_id: string | null;
  supervisor_id: string | null;
  started_at: string | null;
  created_at: string;
}

export interface BoardProgress {
  line_count: number;
  expected_qty: number | string;
  received_qty: number | string;
  short_lines: number;
  over_lines: number;
  unexpected_lines: number;
  hold_lines: number;
}

export interface BoardAction {
  label: string;
  icon: LucideIcon;
  run: () => void;
}

export interface AppointmentWindow {
  window_start: string;
  window_end: string;
  reference: string | null;
  state: string;
}

interface Props {
  sessions: BoardSession[];
  progress: Map<string, BoardProgress> | undefined;
  dockLabel: (id: string | null) => string | null;
  appointment: (id: string | null) => AppointmentWindow | null;
  /** Physical trailer behind the appointment (carrier, seal, dwell) — read-only. */
  trailerVisit?: (appointmentId: string | null) => TrailerVisitInfo | null;
  supervisorLabel: (id: string | null) => string;
  actions: (s: BoardSession) => BoardAction[];
  onOpen: (s: BoardSession) => void;
}


/** Lanes in operational order — the path a trailer walks through the dock. */
const LANES: { state: RcvState; title: string; tone: "neutral" | "info" | "warning" | "danger" | "success" }[] = [
  { state: "open", title: "Arrived", tone: "neutral" },
  { state: "unloading", title: "Unloading", tone: "info" },
  { state: "captured", title: "Captured", tone: "warning" },
  { state: "discrepant", title: "Discrepant", tone: "danger" },
  { state: "posted", title: "Posted", tone: "success" },
];

function windowLabel(w: AppointmentWindow | null): string | null {
  if (!w) return null;
  const s = new Date(w.window_start);
  const e = new Date(w.window_end);
  const time = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${s.toLocaleDateString()} ${time(s)}–${time(e)}`;
}

function SessionCard({
  s, progress, dockLabel, appointment, trailerVisit, supervisorLabel, actions, onOpen,
}: Props & { s: BoardSession }) {
  const pr = progress?.get(s.id);
  const expected = Number(pr?.expected_qty ?? 0);
  const received = Number(pr?.received_qty ?? 0);
  const pct = expected > 0 ? Math.min(100, Math.round((received / expected) * 100)) : received > 0 ? 100 : 0;
  const appt = appointment(s.appointment_id);
  const visit = trailerVisit?.(s.appointment_id) ?? null;
  const dwell = visit ? dwellMinutes(visit) : null;

  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm space-y-2">
      <div className="flex items-start justify-between gap-2">
        <button className="font-mono text-sm font-medium hover:underline" onClick={() => onOpen(s)}>
          {s.code}
        </button>
        <ActivityHistoryButton aggregateId={s.id} recordLabel={s.code} label="" />
      </div>

      <div className="space-y-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <DoorOpen className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{dockLabel(s.dock_id) ?? "unassigned door"}</span>
        </div>
        {visit ? (
          <div className="flex items-center gap-1.5">
            <Truck className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {[visit.carrier_name, visit.trailer_ref].filter(Boolean).join(" · ") || "trailer on dock"}
              {visit.driver_name ? ` · ${visit.driver_name}` : ""}
            </span>
          </div>
        ) : null}
        {visit && (visit.seal_in || visit.seal_out) ? (
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              seal in {visit.seal_in ?? "—"}
              {visit.seal_out ? ` · out ${visit.seal_out}` : ""}
            </span>
          </div>
        ) : null}
        {dwell != null ? (
          <div className="flex items-center gap-1.5">
            <Timer className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {visit?.departed_at ? "dwell" : "on site"} {dwell} min
            </span>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <CalendarClock className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {windowLabel(appt) ?? (s.started_at ? `started ${new Date(s.started_at).toLocaleString()}` : "unscheduled arrival")}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <UserRound className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{supervisorLabel(s.supervisor_id)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {s.source_doc_type ? s.source_doc_type.replace(/_/g, " ") : "blind receipt"}
            {appt?.reference ? ` · ${appt.reference}` : ""}
          </span>
        </div>
      </div>



      <div className="space-y-1">
        <Progress value={pct} className="h-1.5" />
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            {pr && pr.line_count > 0 ? `${received} / ${expected} units` : "no lines yet"}
          </span>
          <span>{pct}%</span>
        </div>
      </div>

      {pr && (pr.short_lines || pr.over_lines || pr.unexpected_lines || pr.hold_lines) ? (
        <div className="flex flex-wrap gap-1 text-[11px]">
          {pr.short_lines > 0 && <StatusBadge tone="danger">{pr.short_lines} short</StatusBadge>}
          {pr.over_lines > 0 && <StatusBadge tone="warning">{pr.over_lines} over</StatusBadge>}
          {pr.unexpected_lines > 0 && <StatusBadge tone="warning">{pr.unexpected_lines} extra</StatusBadge>}
          {pr.hold_lines > 0 && <StatusBadge tone="danger">{pr.hold_lines} hold</StatusBadge>}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1 pt-1">
        <Button size="sm" variant="outline" onClick={() => onOpen(s)}>Open</Button>
        {actions(s).map((a, i) => (
          <Button key={i} size="sm" variant={a.label.startsWith("Post") ? "default" : "outline"} onClick={a.run}>
            <a.icon className="mr-1 h-3.5 w-3.5" />{a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function ReceivingSessionBoard(props: Props) {
  const { sessions } = props;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      {LANES.map((lane) => {
        const laneSessions = sessions.filter((s) => s.state === lane.state);
        return (
          <div key={lane.state} className="rounded-lg bg-muted/40 p-2">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-sm font-medium">{lane.title}</span>
              <StatusBadge tone={lane.tone}>{laneSessions.length}</StatusBadge>
            </div>
            <div className="space-y-2">
              {laneSessions.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">Empty</p>
              ) : (
                laneSessions.map((s) => <SessionCard key={s.id} {...props} s={s} />)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default ReceivingSessionBoard;
