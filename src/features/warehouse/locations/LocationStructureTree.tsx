/**
 * LocationStructureTree — the "walk the warehouse" pane.
 *
 * A flattened, windowed tree: only expanded rows are materialised, so a
 * 20 000-bin warehouse renders in constant time. Each row shows the
 * operational overlay (stock, open work, occupancy) because a supervisor
 * scanning the tree is looking for exceptions, not names.
 */
import { useMemo, useRef } from "react";
import { ChevronRight, Ban, Boxes } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { locationState, type LocationNode } from "./types";
import { LEVEL } from "./vocabulary";
import { OccupancyBar } from "./OccupancyBar";

interface Props {
  roots: LocationNode[];
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (node: LocationNode) => void;
  filter: (node: LocationNode) => boolean;
}

interface FlatRow {
  node: LocationNode;
  hasChildren: boolean;
  isOpen: boolean;
}

const ROW_HEIGHT = 40;

export function LocationStructureTree({
  roots,
  expanded,
  onToggle,
  selectedId,
  onSelect,
  filter,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    const visit = (nodes: LocationNode[]) => {
      nodes.forEach((n) => {
        const kept = n.children.filter((c) => subtreeMatches(c, filter));
        const self = filter(n) || kept.length > 0;
        if (!self) return;
        const isOpen = expanded.has(n.id);
        out.push({ node: n, hasChildren: n.children.length > 0, isOpen });
        if (isOpen) visit(kept.length > 0 ? kept : n.children);
      });
    };
    visit(roots.filter((r) => subtreeMatches(r, filter)));
    return out;
  }, [roots, expanded, filter]);

  if (rows.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No locations match. Clear the search or build the structure from the
        Designer.
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-auto">
      <div role="tree" aria-label="Warehouse structure">
        {rows.map(({ node, hasChildren, isOpen }) => {
          const state = locationState(node);
          const selected = node.id === selectedId;
          return (
            <div
              key={node.id}
              role="treeitem"
              aria-expanded={hasChildren ? isOpen : undefined}
              aria-selected={selected}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(node);
                }
                if (e.key === "ArrowRight" && hasChildren && !isOpen) onToggle(node.id);
                if (e.key === "ArrowLeft" && hasChildren && isOpen) onToggle(node.id);
              }}
              onClick={() => onSelect(node)}
              style={{ height: ROW_HEIGHT, paddingLeft: 8 + node.depth * 14 }}
              className={cn(
                "flex cursor-pointer items-center gap-2 border-b pr-2 text-sm outline-none transition-colors",
                selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
              )}
            >
              <button
                type="button"
                aria-label={isOpen ? "Collapse" : "Expand"}
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded",
                  !hasChildren && "invisible",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(node.id);
                }}
              >
                <ChevronRight
                  className={cn("h-4 w-4 transition-transform", isOpen && "rotate-90")}
                />
              </button>

              <span className="w-14 shrink-0 truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                {node.structure_level ? LEVEL[node.structure_level].singular : "Area"}
              </span>

              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{node.code}</span>
                {node.name && node.name !== node.code && (
                  <span className="ml-2 text-muted-foreground">{node.name}</span>
                )}
              </span>

              {state === "blocked" && (
                <Ban className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Blocked" />
              )}
              {node.metrics.open_tasks > 0 && (
                <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">
                  {node.metrics.open_tasks} open
                </Badge>
              )}
              {node.metrics.sku_count > 0 && (
                <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex">
                  <Boxes className="h-3.5 w-3.5" />
                  {node.metrics.sku_count}
                </span>
              )}
              <div className="hidden w-20 shrink-0 md:block">
                <OccupancyBar pct={node.metrics.occupancy_pct} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function subtreeMatches(node: LocationNode, filter: (n: LocationNode) => boolean): boolean {
  if (filter(node)) return true;
  return node.children.some((c) => subtreeMatches(c, filter));
}
