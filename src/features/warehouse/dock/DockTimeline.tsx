/**
 * DockTimeline — resource-timeline (Gantt) board: one lane per dock,
 * appointments positioned by real time, drag to reschedule.
 *
 * Drag is committed through `reschedule_dock_appointment`, which re-runs
 * server-side feasibility (overlap + downtime + capability). The UI never
 * writes the table directly and never assumes the move succeeded.
 */
import { useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { AlertTriangle, Snowflake, Flame, Truck, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  APPOINTMENT_STATE_TONE,
  hhmm,
  type AppointmentRow,
  type DockRow,
  type DowntimeRow,
} from "./dockScheduling";

const PX_PER_MIN = 2; // 120px per hour
const SNAP_MIN = 15;
const LANE_H = 56;

interface Props {
  day: string;
  docks: DockRow[];
  appointments: AppointmentRow[];
  downtime: DowntimeRow[];
  startHour?: number;
  endHour?: number;
  selectedId?: string | null;
  onSelect: (a: AppointmentRow) => void;
  onMove: (input: { appointment: AppointmentRow; dockId: string; deltaMinutes: number }) => void;
  readOnly?: boolean;
}

function clampToDay(iso: string, dayStart: Date, dayEnd: Date) {
  const t = new Date(iso).getTime();
  return Math.min(Math.max(t, dayStart.getTime()), dayEnd.getTime());
}

function AppointmentBlock({
  appt,
  left,
  width,
  selected,
  onSelect,
  readOnly,
}: {
  appt: AppointmentRow;
  left: number;
  width: number;
  selected: boolean;
  onSelect: () => void;
  readOnly?: boolean;
}) {
  const locked =
    readOnly || appt.state === "completed" || appt.state === "cancelled" || appt.state === "no_show";
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `appt:${appt.id}`,
    data: { appt },
    disabled: locked,
  });

  const Icon = appt.appointment_type === "inbound" ? ArrowDownToLine : ArrowUpFromLine;

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onSelect}
      {...listeners}
      {...attributes}
      style={{
        left,
        width: Math.max(width, 44),
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
      className={cn(
        "absolute top-1.5 h-[44px] rounded-md border px-2 text-left text-xs overflow-hidden",
        APPOINTMENT_STATE_TONE[appt.state],
        selected && "ring-2 ring-primary",
        isDragging ? "z-50 opacity-90 shadow-lg cursor-grabbing" : locked ? "cursor-pointer" : "cursor-grab",
      )}
      title={`${appt.appointment_no ?? ""} ${hhmm(appt.window_start)}–${hhmm(appt.window_end)}`}
    >
      <div className="flex items-center gap-1 font-medium truncate">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{appt.appointment_no ?? appt.reference ?? "Appointment"}</span>
        {(appt.priority === "high" || appt.priority === "critical") && (
          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
        )}
      </div>
      <div className="truncate opacity-80">
        {hhmm(appt.window_start)}–{hhmm(appt.window_end)}
        {appt.trailer_ref ? ` · ${appt.trailer_ref}` : ""}
      </div>
    </button>
  );
}

function DockLane({
  dock,
  children,
  width,
}: {
  dock: DockRow;
  children: React.ReactNode;
  width: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `dock:${dock.id}`, data: { dockId: dock.id } });
  return (
    <div
      ref={setNodeRef}
      style={{ width, height: LANE_H }}
      className={cn("relative border-b", isOver && "bg-primary/5")}
    >
      {children}
    </div>
  );
}

export function DockTimeline({
  day,
  docks,
  appointments,
  downtime,
  startHour = 5,
  endHour = 23,
  selectedId,
  onSelect,
  onMove,
  readOnly,
}: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const dayStart = useMemo(() => new Date(`${day}T${String(startHour).padStart(2, "0")}:00:00`), [day, startHour]);
  const dayEnd = useMemo(() => new Date(`${day}T${String(endHour).padStart(2, "0")}:00:00`), [day, endHour]);
  const totalMin = Math.max(60, (dayEnd.getTime() - dayStart.getTime()) / 60000);
  const boardWidth = totalMin * PX_PER_MIN;

  const hours = useMemo(() => {
    const out: { label: string; left: number }[] = [];
    for (let h = startHour; h <= endHour; h++) {
      out.push({ label: `${String(h).padStart(2, "0")}:00`, left: (h - startHour) * 60 * PX_PER_MIN });
    }
    return out;
  }, [startHour, endHour]);

  const nowLeft = useMemo(() => {
    const now = Date.now();
    if (now < dayStart.getTime() || now > dayEnd.getTime()) return null;
    return ((now - dayStart.getTime()) / 60000) * PX_PER_MIN;
  }, [dayStart, dayEnd]);

  const byDock = useMemo(() => {
    const m = new Map<string, AppointmentRow[]>();
    for (const a of appointments) {
      const list = m.get(a.dock_id) ?? [];
      list.push(a);
      m.set(a.dock_id, list);
    }
    return m;
  }, [appointments]);

  const downtimeByDock = useMemo(() => {
    const m = new Map<string, DowntimeRow[]>();
    for (const d of downtime) {
      const list = m.get(d.dock_id) ?? [];
      list.push(d);
      m.set(d.dock_id, list);
    }
    return m;
  }, [downtime]);

  function geometry(startIso: string, endIso: string) {
    const s = clampToDay(startIso, dayStart, dayEnd);
    const e = clampToDay(endIso, dayStart, dayEnd);
    const left = ((s - dayStart.getTime()) / 60000) * PX_PER_MIN;
    const width = Math.max(((e - s) / 60000) * PX_PER_MIN, 8);
    return { left, width };
  }

  function handleDragStart(ev: DragStartEvent) {
    setDragging(String(ev.active.id));
  }

  function handleDragEnd(ev: DragEndEvent) {
    setDragging(null);
    const appt = ev.active.data.current?.appt as AppointmentRow | undefined;
    if (!appt) return;
    const targetDock = (ev.over?.data.current as { dockId?: string } | undefined)?.dockId ?? appt.dock_id;
    const rawMinutes = ev.delta.x / PX_PER_MIN;
    const deltaMinutes = Math.round(rawMinutes / SNAP_MIN) * SNAP_MIN;
    if (deltaMinutes === 0 && targetDock === appt.dock_id) return;
    onMove({ appointment: appt, dockId: targetDock, deltaMinutes });
  }

  if (docks.length === 0) return null;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex rounded-md border overflow-hidden">
        {/* Dock rail */}
        <div className="shrink-0 w-44 border-r bg-muted/30">
          <div className="h-8 border-b px-3 flex items-center text-xs font-medium text-muted-foreground">
            Dock
          </div>
          {docks.map((d) => {
            const caps = d.capabilities ?? {};
            return (
              <div key={d.id} style={{ height: LANE_H }} className="border-b px-3 flex flex-col justify-center">
                <div className="text-sm font-medium truncate flex items-center gap-1">
                  {d.code}
                  {caps.refrigerated ? <Snowflake className="h-3 w-3 text-blue-500" /> : null}
                  {caps.hazmat ? <Flame className="h-3 w-3 text-amber-600" /> : null}
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {d.name ?? d.dock_type}
                </div>
              </div>
            );
          })}
        </div>

        {/* Scrollable board */}
        <div ref={scrollRef} className="flex-1 overflow-x-auto">
          <div style={{ width: boardWidth }} className="relative">
            <div className="h-8 border-b relative bg-muted/20">
              {hours.map((h) => (
                <div
                  key={h.label}
                  style={{ left: h.left }}
                  className="absolute top-0 h-8 border-l pl-1 text-[11px] text-muted-foreground"
                >
                  {h.label}
                </div>
              ))}
            </div>

            {nowLeft !== null && (
              <div
                style={{ left: nowLeft, height: docks.length * LANE_H + 32 }}
                className="absolute top-0 w-px bg-destructive/70 z-30 pointer-events-none"
              />
            )}

            {docks.map((dock) => {
              const list = byDock.get(dock.id) ?? [];
              const downs = downtimeByDock.get(dock.id) ?? [];
              return (
                <DockLane key={dock.id} dock={dock} width={boardWidth}>
                  {hours.map((h) => (
                    <div
                      key={h.label}
                      style={{ left: h.left }}
                      className="absolute top-0 bottom-0 border-l border-border/50 pointer-events-none"
                    />
                  ))}
                  {downs.map((d) => {
                    const g = geometry(d.window_start, d.window_end);
                    return (
                      <div
                        key={d.id}
                        style={{ left: g.left, width: g.width }}
                        title={`${d.reason}${d.notes ? ` — ${d.notes}` : ""}`}
                        className="absolute top-1 bottom-1 rounded bg-[repeating-linear-gradient(45deg,hsl(var(--muted-foreground)/0.18)_0_6px,transparent_6px_12px)] border border-dashed border-muted-foreground/40 pointer-events-none"
                      />
                    );
                  })}
                  {list.map((a) => {
                    const g = geometry(a.window_start, a.window_end);
                    return (
                      <AppointmentBlock
                        key={a.id}
                        appt={a}
                        left={g.left}
                        width={g.width}
                        selected={selectedId === a.id || dragging === `appt:${a.id}`}
                        onSelect={() => onSelect(a)}
                        readOnly={readOnly}
                      />
                    );
                  })}
                </DockLane>
              );
            })}
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
        <Truck className="h-3 w-3" /> Drag a block sideways to shift its window (15-minute snap), or onto
        another lane to move docks. Every move is re-validated server-side.
      </p>
    </DndContext>
  );
}

export default DockTimeline;
