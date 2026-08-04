/**
 * Dock and yard strip — the physical half of the outbound picture.
 *
 * Docks with what is standing in them, plus the trailers waiting in the yard
 * and how long they have been waiting. Projection of
 * `wms_outbound_dock_board`.
 */
import { Link } from "react-router-dom";
import { Container, DoorOpen, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/design-system";
import type { DockBoard } from "./contract";

export function DockYardStrip({ board }: { board: DockBoard | undefined }) {
  const docks = board?.docks ?? [];
  const waiting = board?.waiting_trailers ?? [];

  if (docks.length === 0 && waiting.length === 0) {
    return (
      <EmptyState
        title="No dock activity"
        description="No outbound dock is configured or occupied for this warehouse."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid min-w-0 grid-cols-1 gap-2 @[26rem]/page:grid-cols-2 @xl/page:grid-cols-3 @5xl/page:grid-cols-4">
        {docks.map((d) => (
          <div
            key={d.dock_id}
            className={cn(
              "min-w-0 rounded-lg border p-3",
              d.occupied ? "border-primary/40 bg-primary/5" : "bg-card",
            )}
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <DoorOpen className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{d.code}</span>
              </span>
              <span className="shrink-0 text-[11px] uppercase text-muted-foreground">
                {d.occupied ? "Occupied" : "Free"}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {d.trailer_ref ?? d.name ?? "—"}
            </p>
            <p className="text-xs text-muted-foreground">
              {d.open_manifests} open load{d.open_manifests === 1 ? "" : "s"}
            </p>
          </div>
        ))}
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          Waiting in yard ({waiting.length})
          {board?.yard_slots
            ? ` · ${board.yard_slots.free}/${board.yard_slots.total} slots free`
            : ""}
        </p>
        {waiting.length === 0 ? (
          <p className="text-sm text-muted-foreground">No trailer is waiting.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {waiting.slice(0, 8).map((t) => (
              <li key={t.visit_id} className="flex items-center gap-3 p-2.5 text-sm">
                <Container className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {t.trailer_ref ?? "Unidentified trailer"}
                </span>
                <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                  <Timer className="h-3 w-3" />
                  {t.waiting_minutes ?? 0}m
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link
          to="/warehouse-app/yard"
          className="mt-2 inline-block text-xs text-muted-foreground hover:text-foreground"
        >
          Open yard control tower →
        </Link>
      </div>
    </div>
  );
}
