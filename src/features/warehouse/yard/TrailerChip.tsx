/**
 * TrailerChip — the single visual token for "a trailer that is on site".
 * Used on the yard map, in the lanes board and on the dock strip so an
 * operator learns one card, not three.
 *
 * Draggable via dnd-kit; dropping it on a slot or dock issues the matching
 * RPC (see YardControlTower).
 */
import { useDraggable } from "@dnd-kit/core";
import { Badge } from "@/components/ui/badge";
import { GripVertical, ShieldCheck, AlertTriangle, Snowflake } from "lucide-react";
import {
  DWELL_BAND_RING,
  DWELL_BAND_TEXT,
  dwellBand,
  dwellMinutes,
  formatDwell,
  isOverdue,
  VISIT_STATUS_LABEL,
  type VisitRow,
} from "./yardModel";
import { toneText } from "@/design-system";
import { cn } from "@/lib/utils";

export function TrailerChip({
  visit,
  onOpen,
  compact,
  draggable = true,
}: {
  visit: VisitRow;
  onOpen: (v: VisitRow) => void;
  compact?: boolean;
  draggable?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `visit:${visit.id}`,
    data: { visit },
    disabled: !draggable,
  });

  const mins = dwellMinutes(visit);
  const band = dwellBand(mins);
  const overdue = isOverdue(visit);
  const reefer = visit.appointment?.appointment_type === "inbound" && false;

  return (
    <div
      ref={setNodeRef}
      className={`rounded-md border bg-card ${DWELL_BAND_RING[band]} ${
        isDragging ? "opacity-40" : ""
      } ${compact ? "p-2" : "p-2.5"} shadow-sm`}
    >
      <div className="flex items-start gap-1.5">
        {draggable && (
          <button
            type="button"
            className="mt-0.5 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
            aria-label={`Move trailer ${visit.trailer_ref}`}
            {...listeners}
            {...attributes}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" className="flex-1 min-w-0 text-left" onClick={() => onOpen(visit)}>
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-sm truncate">{visit.trailer_ref}</span>
            {visit.departure_approved_at && <ShieldCheck className={cn("h-3.5 w-3.5 shrink-0", toneText("success"))} />}
            {overdue && <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />}
            {reefer && <Snowflake className={cn("h-3.5 w-3.5 shrink-0", toneText("info"))} />}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">
            {visit.carrier?.name ?? "Walk-in"}
            {visit.driver_name ? ` · ${visit.driver_name}` : ""}
          </div>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            <span className={`text-[11px] font-medium ${DWELL_BAND_TEXT[band]}`}>{formatDwell(mins)}</span>
            {!compact && (
              <Badge variant="outline" className="text-[10px] px-1 py-0">
                {VISIT_STATUS_LABEL[visit.status]}
              </Badge>
            )}
            {visit.appointment?.appointment_no && (
              <Badge variant="secondary" className="text-[10px] px-1 py-0">
                {visit.appointment.appointment_no}
              </Badge>
            )}
          </div>
        </button>
      </div>
    </div>
  );
}
