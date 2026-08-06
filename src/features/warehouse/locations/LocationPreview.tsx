/**
 * LocationPreview — the side-pane preview for one physical position
 * (ADR 0122).
 *
 * Answers "what is this, what's in it, what's happening to it, what can I
 * do this second". Authoring — description, label code, walk order,
 * capacity, put-away behaviour — moved to the location workspace, because
 * configuration is a deliberate act and does not belong beside a tree an
 * operator is scanning through.
 */
import { Printer, Ban, RotateCcw, Plus, MoveRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/design-system";
import { locationState, type LocationNode } from "./types";
import { LEVEL, STATE_COPY, addActionLabel, levelLabel } from "./vocabulary";
import { OccupancyBar } from "./OccupancyBar";
import { useLocationMutations } from "./useLocationMutations";
import {
  EntityPreview,
  EntityPreviewEmpty,
  PreviewFact,
} from "@/features/warehouse/entity/EntityPreview";

export function locationWorkspaceHref(id: string) {
  return `/warehouse-app/layout/location/${id}`;
}

interface Props {
  node: LocationNode | null;
  warehouseId: string | null;
  onPrintLabel: (nodes: LocationNode[]) => void;
  onAddInside: (parent: LocationNode) => void;
  onMove?: (node: LocationNode) => void;
}

export function LocationPreview({
  node,
  warehouseId,
  onPrintLabel,
  onAddInside,
  onMove,
}: Props) {
  const { setActive } = useLocationMutations(warehouseId);

  if (!node) {
    return (
      <EntityPreviewEmpty
        title="Pick a location"
        description="Choose a zone, aisle, rack, shelf or bin to see what's inside it and what work is open against it."
      />
    );
  }

  const state = locationState(node);
  const m = node.metrics;

  return (
    <EntityPreview
      eyebrow={levelLabel(node.structure_level)}
      context={node.path.slice(0, -1).join(" / ") || "Warehouse"}
      title={node.code}
      subtitle={node.name && node.name !== node.code ? node.name : undefined}
      status={
        <StatusBadge
          tone={state === "blocked" ? "danger" : state === "full" ? "warning" : "success"}
        >
          {STATE_COPY[state].label}
        </StatusBadge>
      }
      metrics={[
        { label: "On hand", value: m.on_hand_units.toLocaleString() },
        { label: "Reserved", value: m.reserved_units.toLocaleString() },
        { label: "Products", value: m.sku_count.toLocaleString() },
        { label: "Lots", value: m.lot_count.toLocaleString() },
      ]}
      workspaceHref={locationWorkspaceHref(node.id)}
      workspaceLabel="Open location workspace"
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => onPrintLabel([node])}>
            <Printer className="mr-2 h-4 w-4" /> Print label
          </Button>
          {node.structure_level && LEVEL[node.structure_level] && (
            <Button size="sm" variant="outline" onClick={() => onAddInside(node)}>
              <Plus className="mr-2 h-4 w-4" /> {addActionLabel(node.structure_level)}
            </Button>
          )}
          {onMove && node.structure_level && (
            <Button size="sm" variant="outline" onClick={() => onMove(node)}>
              <MoveRight className="mr-2 h-4 w-4" /> Move to…
            </Button>
          )}
          <Button
            size="sm"
            variant={node.is_active ? "outline" : "default"}
            onClick={() => setActive.mutate({ id: node.id, active: !node.is_active })}
          >
            {node.is_active ? (
              <>
                <Ban className="mr-2 h-4 w-4" /> Block
              </>
            ) : (
              <>
                <RotateCcw className="mr-2 h-4 w-4" /> Return to service
              </>
            )}
          </Button>
        </>
      }
    >
      <section className="space-y-2">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Capacity used</span>
          <span>
            {m.occupancy_pct === null ? "No capacity set" : `${Math.round(m.occupancy_pct)}%`}
          </span>
        </div>
        <OccupancyBar pct={m.occupancy_pct} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Open work</h3>
        <div className="flex flex-wrap gap-2">
          {m.putaway_tasks > 0 && <Badge variant="secondary">{m.putaway_tasks} put-away</Badge>}
          {m.pick_tasks > 0 && <Badge variant="secondary">{m.pick_tasks} picks</Badge>}
          {m.count_tasks > 0 && <Badge variant="secondary">{m.count_tasks} counts</Badge>}
          {m.open_tasks === 0 && (
            <span className="text-xs text-muted-foreground">No open warehouse work.</span>
          )}
        </div>
        {m.last_movement_at && (
          <p className="text-xs text-muted-foreground">
            Last movement {new Date(m.last_movement_at).toLocaleString()}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">How it behaves</h3>
        <PreviewFact label="Label code" value={node.barcode || "Not labelled"} />
        <PreviewFact label="Walk order" value={node.pick_sequence ?? "—"} />
        <PreviewFact
          label="Holds up to"
          value={
            node.capacity_max_units === null
              ? "Not set"
              : `${node.capacity_max_units.toLocaleString()} units`
          }
        />
        <PreviewFact
          label="Put-away target"
          value={node.is_putaway_target ? "Yes" : "No"}
        />
      </section>
    </EntityPreview>
  );
}

export default LocationPreview;
