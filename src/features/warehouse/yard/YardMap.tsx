/**
 * YardMap — the spatial view. Zones (approach → waiting → parking →
 * staging → overflow) render as columns of slot cells; each cell is a
 * drop target that relocates the trailer dropped on it.
 *
 * A slot that is `blocked` refuses drops and reads as hatched.
 */
import { useDroppable } from "@dnd-kit/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Ban, CircleSlash, Pencil, ParkingSquare } from "lucide-react";
import { TrailerChip } from "./TrailerChip";
import {
  SLOT_TYPE_LABEL,
  YARD_ZONE_ORDER,
  yardZoneLabel,
  type VisitRow,
  type YardSlotRow,
  type YardZoneKind,
} from "./yardModel";

function SlotCell({
  slot,
  visit,
  onOpenVisit,
  onEditSlot,
  onToggleBlocked,
}: {
  slot: YardSlotRow;
  visit?: VisitRow;
  onOpenVisit: (v: VisitRow) => void;
  onEditSlot: (s: YardSlotRow) => void;
  onToggleBlocked: (s: YardSlotRow) => void;
}) {
  const blocked = slot.status === "blocked";
  const { setNodeRef, isOver } = useDroppable({
    id: `slot:${slot.id}`,
    data: { slot },
    disabled: blocked,
  });

  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border p-2 min-h-[92px] transition-colors ${
        blocked
          ? "border-dashed bg-muted/40"
          : isOver
            ? "border-primary bg-primary/5"
            : visit
              ? "bg-card"
              : "border-dashed bg-muted/20"
      }`}
    >
      <div className="flex items-center justify-between gap-1 mb-1.5">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-xs font-semibold truncate">{slot.code}</span>
          <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
            {SLOT_TYPE_LABEL[slot.slot_type] ?? slot.slot_type}
          </Badge>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            title={blocked ? "Unblock slot" : "Block slot"}
            onClick={() => onToggleBlocked(slot)}
          >
            {blocked ? <CircleSlash className="h-3 w-3 text-destructive" /> : <Ban className="h-3 w-3" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-5 w-5" title="Edit slot" onClick={() => onEditSlot(slot)}>
            <Pencil className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {visit ? (
        <TrailerChip visit={visit} onOpen={onOpenVisit} compact />
      ) : (
        <p className="text-[11px] text-muted-foreground py-2 text-center">
          {blocked ? "Blocked" : "Free"}
        </p>
      )}
    </div>
  );
}

export function YardMap({
  slots,
  visits,
  onOpenVisit,
  onEditSlot,
  onToggleBlocked,
  onAddSlot,
}: {
  slots: YardSlotRow[];
  visits: VisitRow[];
  onOpenVisit: (v: VisitRow) => void;
  onEditSlot: (s: YardSlotRow) => void;
  onToggleBlocked: (s: YardSlotRow) => void;
  onAddSlot: () => void;
}) {
  const bySlot = new Map<string, VisitRow>();
  for (const v of visits) if (v.yard_slot_id) bySlot.set(v.yard_slot_id, v);

  const zones: { zone: YardZoneKind | "unzoned"; rows: YardSlotRow[] }[] = [];
  for (const z of YARD_ZONE_ORDER) {
    const rows = slots.filter((s) => s.zone_kind === z);
    if (rows.length) zones.push({ zone: z, rows });
  }
  const unzoned = slots.filter((s) => !s.zone_kind);
  if (unzoned.length) zones.push({ zone: "unzoned", rows: unzoned });

  if (!slots.length) {
    return (
      <Card>
        <CardContent className="py-12 text-center space-y-3">
          <ParkingSquare className="h-8 w-8 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No yard slots defined for this warehouse yet. Slots are the parking positions the gate
            assigns trailers to on check-in.
          </p>
          <Button size="sm" onClick={onAddSlot}>
            Add the first slot
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {zones.map(({ zone, rows }) => {
        const occupied = rows.filter((s) => bySlot.has(s.id)).length;
        return (
          <Card key={zone}>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center justify-between">
                <span>{zone === "unzoned" ? "Unzoned" : yardZoneLabel(zone)}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {occupied}/{rows.length} occupied
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {rows.map((s) => (
                  <SlotCell
                    key={s.id}
                    slot={s}
                    visit={bySlot.get(s.id)}
                    onOpenVisit={onOpenVisit}
                    onEditSlot={onEditSlot}
                    onToggleBlocked={onToggleBlocked}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
