/**
 * YardLanes — the flow view. Three lanes mirroring the visit state
 * machine (`arrived → in_yard → at_dock`) plus a dock strip, so the
 * supervisor sees the queue, not just the parking layout.
 *
 * The dock lane is a drop target: dropping a trailer on a dock calls
 * `assign_trailer_to_dock`.
 */
import { useDroppable } from "@dnd-kit/core";
import { Section, EmptyState } from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { DoorOpen } from "lucide-react";
import { TrailerChip } from "./TrailerChip";
import { dwellMinutes, VISIT_STATUS_LABEL, type VisitRow } from "./yardModel";

function Lane({
  title,
  hint,
  visits,
  onOpenVisit,
}: {
  title: string;
  hint?: string;
  visits: VisitRow[];
  onOpenVisit: (v: VisitRow) => void;
}) {
  return (
    <Section
      className="flex flex-col"
      title={title}
      description={hint}
      actions={
        <Badge variant="secondary" className="text-[10px]">
          {visits.length}
        </Badge>
      }
      contentClassName="space-y-2"
    >
      {visits.length === 0 ? (
        <EmptyState title="Lane empty" description="No trailer is holding in this lane." />
      ) : (
        visits.map((v) => <TrailerChip key={v.id} visit={v} onOpen={onOpenVisit} />)
      )}
    </Section>
  );
}

function DockCell({
  dock,
  visit,
  onOpenVisit,
}: {
  dock: { id: string; code: string; name: string | null };
  visit?: VisitRow;
  onOpenVisit: (v: VisitRow) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `dock:${dock.id}`, data: { dock } });
  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border p-2 min-h-[92px] transition-colors ${
        isOver ? "border-primary bg-primary/5" : visit ? "bg-card" : "border-dashed bg-muted/20"
      }`}
    >
      <div className="flex items-center gap-1 mb-1.5">
        <DoorOpen className="h-3 w-3 text-muted-foreground" />
        <span className="text-xs font-semibold truncate">{dock.name || dock.code}</span>
      </div>
      {visit ? (
        <TrailerChip visit={visit} onOpen={onOpenVisit} compact />
      ) : (
        <p className="text-[11px] text-muted-foreground py-2 text-center">Idle</p>
      )}
    </div>
  );
}

export function YardLanes({
  visits,
  docks,
  onOpenVisit,
}: {
  visits: VisitRow[];
  docks: { id: string; code: string; name: string | null }[];
  onOpenVisit: (v: VisitRow) => void;
}) {
  const byAge = (a: VisitRow, b: VisitRow) => dwellMinutes(b) - dwellMinutes(a);
  const atGate = visits.filter((v) => v.status === "arrived").sort(byAge);
  const inYard = visits.filter((v) => v.status === "in_yard").sort(byAge);
  const cleared = visits.filter((v) => v.departure_approved_at && v.status !== "departed").sort(byAge);
  const byDock = new Map<string, VisitRow>();
  for (const v of visits) if (v.status === "at_dock" && v.dock_id) byDock.set(v.dock_id, v);

  return (
    <div className="space-y-4">
      <div className="min-w-0 grid gap-3 @2xl/page:grid-cols-3">
        <Lane
          title={VISIT_STATUS_LABEL.arrived}
          hint="Checked in, awaiting a yard position"
          visits={atGate}
          onOpenVisit={onOpenVisit}
        />
        <Lane
          title={VISIT_STATUS_LABEL.in_yard}
          hint="Parked, waiting for a dock"
          visits={inYard}
          onOpenVisit={onOpenVisit}
        />
        <Lane
          title="Cleared to leave"
          hint="Work closed, awaiting gate exit"
          visits={cleared}
          onOpenVisit={onOpenVisit}
        />
      </div>

      <Section title="Dock face" description="Drop a trailer on a dock to assign it.">
          {docks.length === 0 ? (
            <EmptyState
              title="No active docks"
              description="This warehouse has no dock doors configured as active."
            />
          ) : (
            <div className="min-w-0 grid gap-2 grid-cols-2 @xl/page:grid-cols-3 @4xl/page:grid-cols-4 @5xl/page:grid-cols-6">
              {docks.map((d) => (
                <DockCell key={d.id} dock={d} visit={byDock.get(d.id)} onOpenVisit={onOpenVisit} />
              ))}
            </div>
          )}
      </Section>
    </div>
  );
}
