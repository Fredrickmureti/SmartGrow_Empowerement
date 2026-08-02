/**
 * LocationMap — the floor view.
 *
 * A drill-down spatial grid: zones → aisles → racks → shelves → bins. Each
 * cell is colour-coded by operational state so a supervisor sees congestion,
 * blocked positions and empty capacity the way they would walking the floor.
 */
import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { locationState, type LocationNode, type LocationState } from "./types";
import { LEVEL, STATE_COPY } from "./vocabulary";

interface Props {
  roots: LocationNode[];
  /** Location whose children are drawn. Null = warehouse root. */
  focusId: string | null;
  byId: Map<string, LocationNode>;
  onFocus: (id: string | null) => void;
  selectedId: string | null;
  onSelect: (node: LocationNode) => void;
}

const STATE_CLASS: Record<LocationState, string> = {
  blocked: "bg-destructive/15 border-destructive/40 text-destructive",
  full: "bg-primary/80 border-primary text-primary-foreground",
  busy: "bg-accent border-accent-foreground/20 text-accent-foreground",
  stocked: "bg-primary/25 border-primary/40",
  empty: "bg-muted border-border text-muted-foreground",
};

export function LocationMap({ roots, focusId, byId, onFocus, selectedId, onSelect }: Props) {
  const focus = focusId ? byId.get(focusId) ?? null : null;
  const cells = focus ? focus.children : roots;

  const crumbs = useMemo(() => {
    const out: LocationNode[] = [];
    let cur = focus;
    while (cur) {
      out.unshift(cur);
      cur = cur.parent_location_id ? byId.get(cur.parent_location_id) ?? null : null;
    }
    return out;
  }, [focus, byId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-2 text-sm">
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => onFocus(null)}>
          Whole warehouse
        </Button>
        {crumbs.map((c) => (
          <span key={c.id} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => onFocus(c.id)}
            >
              {c.code}
            </Button>
          </span>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-3">
        {cells.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            Nothing inside {focus ? focus.code : "this warehouse"} yet.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
            {cells.map((c) => {
              const state = locationState(c);
              const occ = c.metrics.occupancy_pct;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelect(c)}
                  onDoubleClick={() => c.children.length > 0 && onFocus(c.id)}
                  title={`${c.code} — ${STATE_COPY[state].hint}`}
                  className={cn(
                    "flex h-24 flex-col justify-between rounded-md border p-2 text-left text-xs transition-shadow hover:shadow-md",
                    STATE_CLASS[state],
                    selectedId === c.id && "ring-2 ring-ring",
                  )}
                >
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{c.code}</div>
                    <div className="truncate opacity-80">
                      {c.structure_level ? LEVEL[c.structure_level].singular : "Area"}
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    {occ !== null && <div>{Math.round(occ)}% full</div>}
                    {c.metrics.open_tasks > 0 && <div>{c.metrics.open_tasks} open jobs</div>}
                    {c.children.length > 0 && (
                      <div className="opacity-70">{c.children.length} inside</div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
        {(Object.keys(STATE_CLASS) as LocationState[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={cn("h-3 w-3 rounded border", STATE_CLASS[s])} />
            {STATE_COPY[s].label}
          </span>
        ))}
        <span className="ml-auto">Double-click a tile to step inside.</span>
      </div>
    </div>
  );
}
