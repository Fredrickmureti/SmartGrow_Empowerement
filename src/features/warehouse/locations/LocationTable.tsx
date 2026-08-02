/**
 * LocationTable — the "work on many positions at once" pane (ADR 0104).
 *
 * The tree answers "where is this?"; the floor answers "what is happening?";
 * this table answers "which positions do I need to act on?" — the question a
 * supervisor asks before a labelling run, a re-slot or a count.
 *
 * Rows are windowed with `@tanstack/react-virtual`, so a 500 000-position
 * warehouse scrolls at constant cost. Selection is the input to bulk actions
 * (label printing, barcode assignment) held by the workspace.
 */
import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Barcode, Ban } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { locationState, type LocationNode } from "./types";
import { LEVEL } from "./vocabulary";
import { OccupancyBar } from "./OccupancyBar";

export type TableFilter = "all" | "bins" | "stocked" | "empty" | "busy" | "blocked" | "unlabelled";

interface Props {
  rows: LocationNode[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], select: boolean) => void;
  selectedId: string | null;
  onSelect: (node: LocationNode) => void;
}

const ROW_HEIGHT = 44;

export function matchesTableFilter(node: LocationNode, filter: TableFilter): boolean {
  switch (filter) {
    case "bins":
      return node.structure_level === "bin";
    case "stocked":
      return node.metrics.on_hand_units > 0;
    case "empty":
      return node.is_active && node.metrics.on_hand_units === 0;
    case "busy":
      return node.metrics.open_tasks > 0;
    case "blocked":
      return !node.is_active;
    case "unlabelled":
      return !node.barcode;
    default:
      return true;
  }
}

export function LocationTable({
  rows,
  selected,
  onToggle,
  onToggleAll,
  selectedId,
  onSelect,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid grid-cols-[2rem_minmax(0,1fr)_5rem_5.5rem_6rem_4.5rem_2rem] items-center gap-2 border-b px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <Checkbox
          checked={allSelected}
          aria-label="Select every position in view"
          onCheckedChange={(v) => onToggleAll(ids, v === true)}
        />
        <span>Position</span>
        <span>Kind</span>
        <span className="text-right">On hand</span>
        <span>Fill</span>
        <span className="text-right">Jobs</span>
        <span />
      </div>

      {rows.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">
          No position matches this view.
        </p>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const node = rows[v.index];
              const state = locationState(node);
              const isSelected = selected.has(node.id);
              return (
                <div
                  key={node.id}
                  className={cn(
                    "absolute left-0 top-0 grid w-full cursor-pointer grid-cols-[2rem_minmax(0,1fr)_5rem_5.5rem_6rem_4.5rem_2rem] items-center gap-2 border-b px-3 text-sm",
                    selectedId === node.id && "bg-accent",
                    isSelected && "bg-primary/5",
                  )}
                  style={{ height: v.size, transform: `translateY(${v.start}px)` }}
                  onClick={() => onSelect(node)}
                >
                  <span onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={isSelected}
                      aria-label={`Select ${node.code}`}
                      onCheckedChange={() => onToggle(node.id)}
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[13px] font-medium">
                      {node.code}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {node.path.slice(0, -1).join(" / ") || "Warehouse"}
                      {node.name ? ` · ${node.name}` : ""}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {node.structure_level ? LEVEL[node.structure_level].singular : "—"}
                  </span>
                  <span className="text-right font-mono text-xs">
                    {node.metrics.on_hand_units.toLocaleString()}
                  </span>
                  <span>
                    <OccupancyBar pct={node.metrics.occupancy_pct} />
                  </span>
                  <span className="text-right text-xs">
                    {node.metrics.open_tasks > 0 ? (
                      <Badge variant="secondary">{node.metrics.open_tasks}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {state === "blocked" ? (
                      <Ban className="h-4 w-4 text-destructive" aria-label="Blocked" />
                    ) : node.barcode ? (
                      <Barcode className="h-4 w-4" aria-label="Labelled" />
                    ) : (
                      <Barcode className="h-4 w-4 opacity-25" aria-label="No label yet" />
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
