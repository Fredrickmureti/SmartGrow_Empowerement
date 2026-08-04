/**
 * Strategy workbench — authoring surface for the planning engine.
 *
 * A strategy row IS the plan rule: `wms_plan_waves` reads these rows in
 * sequence and groups demand accordingly. The workbench edits rows; it never
 * simulates or re-implements the grouping.
 */
import { useState } from "react";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { EmptyState, LoadingState } from "@/design-system";
import {
  STRATEGY_GROUP_KEYS, STRATEGY_KINDS, type WaveStrategy,
} from "./contract";
import {
  useDeleteWaveStrategy, useSaveWaveStrategy, useSeedWaveStrategies,
  useToggleWaveStrategy, type WaveStrategyDraft,
} from "./useWaveStrategyAdmin";

interface Props {
  warehouseId: string;
  strategies: WaveStrategy[];
  isLoading?: boolean;
}

function emptyDraft(warehouseId: string): WaveStrategyDraft {
  return {
    warehouse_id: warehouseId,
    name: "",
    kind: "carrier",
    is_active: true,
    sequence: 50,
    group_by: ["carrier"],
    max_orders_per_wave: 60,
    max_lines_per_wave: 800,
    max_units_per_wave: 8000,
    cutoff_offset_minutes: 240,
    auto_plan: false,
    auto_release: false,
    wave_priority: 5,
    task_priority: 5,
    minutes_per_line: 1.5,
    minutes_per_unit: 0.05,
    units_per_carton: 24,
    notes: "",
  };
}

export function StrategyWorkbench({ warehouseId, strategies, isLoading }: Props) {
  const [draft, setDraft] = useState<WaveStrategyDraft | null>(null);
  const save = useSaveWaveStrategy();
  const toggle = useToggleWaveStrategy();
  const remove = useDeleteWaveStrategy();
  const seed = useSeedWaveStrategies();

  const set = <K extends keyof WaveStrategyDraft>(k: K, v: WaveStrategyDraft[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  const toggleGroup = (key: string) =>
    setDraft((d) => {
      if (!d) return d;
      const current = d.group_by ?? [];
      return {
        ...d,
        group_by: current.includes(key)
          ? current.filter((g) => g !== key)
          : [...current, key],
      };
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setDraft(emptyDraft(warehouseId))}>
          <Plus className="mr-2 h-4 w-4" /> New strategy
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={seed.isPending}
          onClick={() => seed.mutate(warehouseId)}
        >
          <Wand2 className="mr-2 h-4 w-4" /> Add defaults
        </Button>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : strategies.length === 0 ? (
        <EmptyState
          title="No planning strategies"
          description="Without a strategy the planner has no rule to group demand by — add the defaults to start."
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {strategies.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 p-3">
              <span className="w-8 text-xs text-muted-foreground">#{s.sequence}</span>
              <button
                type="button"
                className="text-sm font-medium hover:underline"
                onClick={() => setDraft({ ...s })}
              >
                {s.name}
              </button>
              <Badge variant="outline">{s.kind}</Badge>
              {(s.group_by ?? []).map((g) => (
                <Badge key={g} variant="secondary">{g}</Badge>
              ))}
              <span className="text-xs text-muted-foreground">
                max {s.max_orders_per_wave} orders · {s.max_lines_per_wave} lines
                {s.cutoff_offset_minutes ? ` · cut-off +${s.cutoff_offset_minutes}m` : ""}
              </span>
              {s.auto_plan ? <Badge variant="secondary">auto-plan</Badge> : null}
              {s.auto_release ? <Badge variant="secondary">auto-release</Badge> : null}
              <div className="flex-1" />
              <Switch
                checked={s.is_active}
                onCheckedChange={(v) => toggle.mutate({ id: s.id, isActive: v })}
                aria-label={`Activate ${s.name}`}
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Delete ${s.name}`}
                onClick={() => remove.mutate(s.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit strategy" : "New strategy"}</DialogTitle>
          </DialogHeader>
          {draft ? (
            <div className="grid gap-3 @md:grid-cols-2">
              <div className="@md:col-span-2">
                <Label>Name</Label>
                <Input value={draft.name} onChange={(e) => set("name", e.target.value)} />
              </div>

              <div>
                <Label>Kind</Label>
                <Select value={draft.kind} onValueChange={(v) => set("kind", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STRATEGY_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>{k}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Sequence</Label>
                <Input
                  type="number"
                  value={draft.sequence ?? 50}
                  onChange={(e) => set("sequence", Number(e.target.value))}
                />
              </div>

              <div className="@md:col-span-2">
                <Label>Group demand by</Label>
                <div className="mt-1 flex flex-wrap gap-2">
                  {STRATEGY_GROUP_KEYS.map((g) => {
                    const on = (draft.group_by ?? []).includes(g);
                    return (
                      <Button
                        key={g}
                        type="button"
                        size="sm"
                        variant={on ? "default" : "outline"}
                        onClick={() => toggleGroup(g)}
                      >
                        {g}
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div>
                <Label>Max orders / wave</Label>
                <Input
                  type="number"
                  value={draft.max_orders_per_wave ?? 60}
                  onChange={(e) => set("max_orders_per_wave", Number(e.target.value))}
                />
              </div>
              <div>
                <Label>Max lines / wave</Label>
                <Input
                  type="number"
                  value={draft.max_lines_per_wave ?? 800}
                  onChange={(e) => set("max_lines_per_wave", Number(e.target.value))}
                />
              </div>
              <div>
                <Label>Max units / wave</Label>
                <Input
                  type="number"
                  value={draft.max_units_per_wave ?? 8000}
                  onChange={(e) => set("max_units_per_wave", Number(e.target.value))}
                />
              </div>
              <div>
                <Label>Cut-off offset (minutes)</Label>
                <Input
                  type="number"
                  value={draft.cutoff_offset_minutes ?? 240}
                  onChange={(e) => set("cutoff_offset_minutes", Number(e.target.value))}
                />
              </div>
              <div>
                <Label>Minutes per line</Label>
                <Input
                  type="number" step="0.1"
                  value={draft.minutes_per_line ?? 1.5}
                  onChange={(e) => set("minutes_per_line", Number(e.target.value))}
                />
              </div>
              <div>
                <Label>Minutes per unit</Label>
                <Input
                  type="number" step="0.01"
                  value={draft.minutes_per_unit ?? 0.05}
                  onChange={(e) => set("minutes_per_unit", Number(e.target.value))}
                />
              </div>
              <div>
                <Label>Wave priority</Label>
                <Input
                  type="number"
                  value={draft.wave_priority ?? 5}
                  onChange={(e) => set("wave_priority", Number(e.target.value))}
                />
              </div>
              <div>
                <Label>Task priority</Label>
                <Input
                  type="number"
                  value={draft.task_priority ?? 5}
                  onChange={(e) => set("task_priority", Number(e.target.value))}
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  checked={!!draft.auto_plan}
                  onCheckedChange={(v) => set("auto_plan", v)}
                  id="auto-plan"
                />
                <Label htmlFor="auto-plan">Auto-plan</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={!!draft.auto_release}
                  onCheckedChange={(v) => set("auto_release", v)}
                  id="auto-release"
                />
                <Label htmlFor="auto-release">Auto-release when ready</Label>
              </div>

              <div className="@md:col-span-2">
                <Label>Notes</Label>
                <Textarea
                  rows={2}
                  value={draft.notes ?? ""}
                  onChange={(e) => set("notes", e.target.value)}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
            <Button
              disabled={!draft?.name || save.isPending}
              onClick={() =>
                draft &&
                save.mutate(draft, { onSuccess: () => setDraft(null) })
              }
            >
              Save strategy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
