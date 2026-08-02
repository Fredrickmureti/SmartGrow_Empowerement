/**
 * LocationInspector — everything about one physical position.
 *
 * Identity, where it sits, what's in it, what work is open against it,
 * how it behaves during put-away and picking, and its label.
 */
import { useEffect, useState } from "react";
import { Printer, Ban, RotateCcw, Save, Plus, MoveRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { EmptyState, StatusBadge } from "@/design-system";
import { locationState, type LocationNode } from "./types";
import { LEVEL, STATE_COPY, addActionLabel, levelLabel } from "./vocabulary";
import { OccupancyBar } from "./OccupancyBar";
import { useLocationMutations } from "./useLocationMutations";

interface Props {
  node: LocationNode | null;
  warehouseId: string | null;
  onPrintLabel: (nodes: LocationNode[]) => void;
  onAddInside: (parent: LocationNode) => void;
  onMove?: (node: LocationNode) => void;
}


interface Draft {
  name: string;
  barcode: string;
  pick_sequence: string;
  putaway_priority: string;
  capacity_max_units: string;
  is_putaway_target: boolean;
  is_receiving_staging: boolean;
}

function toDraft(n: LocationNode): Draft {
  return {
    name: n.name ?? "",
    barcode: n.barcode ?? "",
    pick_sequence: n.pick_sequence?.toString() ?? "",
    putaway_priority: n.putaway_priority?.toString() ?? "",
    capacity_max_units: n.capacity_max_units?.toString() ?? "",
    is_putaway_target: !!n.is_putaway_target,
    is_receiving_staging: !!n.is_receiving_staging,
  };
}

export function LocationInspector({ node, warehouseId, onPrintLabel, onAddInside }: Props) {
  const { update, setActive } = useLocationMutations(warehouseId);
  const [draft, setDraft] = useState<Draft | null>(node ? toDraft(node) : null);

  useEffect(() => {
    setDraft(node ? toDraft(node) : null);
  }, [node]);

  if (!node || !draft) {
    return (
      <EmptyState
        title="Pick a location"
        description="Choose a zone, aisle, rack, shelf or bin to see what's inside it, what work is open, and how it behaves during put-away and picking."
      />
    );
  }

  const state = locationState(node);
  const m = node.metrics;
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {node.path.slice(0, -1).join(" / ") || "Warehouse"}
        </div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-xl font-semibold">{node.code}</h2>
            <p className="text-sm text-muted-foreground">
              {levelLabel(node.structure_level)}
              {node.name && node.name !== node.code ? ` · ${node.name}` : ""}
            </p>
          </div>
          <StatusBadge tone={state === "blocked" ? "danger" : state === "full" ? "warning" : "success"}>
            {STATE_COPY[state].label}
          </StatusBadge>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
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
        </div>
      </div>

      <div className="flex-1 space-y-6 overflow-auto p-4">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">What's here now</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="On hand" value={m.on_hand_units.toLocaleString()} />
            <Metric label="Reserved" value={m.reserved_units.toLocaleString()} />
            <Metric label="Products" value={m.sku_count.toLocaleString()} />
            <Metric label="Lots" value={m.lot_count.toLocaleString()} />
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Capacity used</span>
              <span>{m.occupancy_pct === null ? "No capacity set" : `${Math.round(m.occupancy_pct)}%`}</span>
            </div>
            <OccupancyBar pct={m.occupancy_pct} />
          </div>
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

        <Separator />

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">How operators find it</h3>
          <Field id="loc-name" label="Description">
            <Input
              id="loc-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field id="loc-barcode" label="Label code" hint="What the scanner reads. Defaults to the location code.">
            <Input
              id="loc-barcode"
              value={draft.barcode}
              placeholder={node.code}
              onChange={(e) => setDraft({ ...draft, barcode: e.target.value })}
            />
          </Field>
          <Field id="loc-seq" label="Walk order" hint="Lower numbers are visited first on a pick round.">
            <Input
              id="loc-seq"
              type="number"
              value={draft.pick_sequence}
              onChange={(e) => setDraft({ ...draft, pick_sequence: e.target.value })}
            />
          </Field>
        </section>

        <Separator />

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">How stock behaves here</h3>
          <Field id="loc-cap" label="Holds up to (units)">
            <Input
              id="loc-cap"
              type="number"
              value={draft.capacity_max_units}
              onChange={(e) => setDraft({ ...draft, capacity_max_units: e.target.value })}
            />
          </Field>
          <Field id="loc-prio" label="Put-away preference" hint="Higher wins when the system suggests where to put stock.">
            <Input
              id="loc-prio"
              type="number"
              value={draft.putaway_priority}
              onChange={(e) => setDraft({ ...draft, putaway_priority: e.target.value })}
            />
          </Field>
          <Toggle
            id="loc-putaway"
            label="Suggest this location for put-away"
            checked={draft.is_putaway_target}
            onChange={(v) => setDraft({ ...draft, is_putaway_target: v })}
          />
          <Toggle
            id="loc-staging"
            label="Goods land here when received"
            checked={draft.is_receiving_staging}
            onChange={(v) => setDraft({ ...draft, is_receiving_staging: v })}
          />
        </section>
      </div>

      <div className="border-t p-3">
        <Button
          className="w-full"
          disabled={update.isPending}
          onClick={() =>
            update.mutate({
              id: node.id,
              patch: {
                name: draft.name,
                barcode: draft.barcode.trim() || null,
                pick_sequence: num(draft.pick_sequence),
                putaway_priority: num(draft.putaway_priority),
                capacity_max_units: num(draft.capacity_max_units),
                is_putaway_target: draft.is_putaway_target,
                is_receiving_staging: draft.is_receiving_staging,
              },
            })
          }
        >
          <Save className="mr-2 h-4 w-4" /> Save location
        </Button>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border p-2">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
