/**
 * LocationRunBuilder — describe a run of locations the way a warehouse
 * manager describes it: "aisles 1–6, four racks each, ten bins per rack".
 *
 * Every structural rule (legal nesting, code format, walk order) lives in
 * `wms_generate_locations`. This component only collects the intent and
 * shows the *dry-run* result of that same function, so the preview is the
 * truth and not a re-implementation of it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LEVEL, childLevels } from "./vocabulary";
import type { LocationNode, StructureLevel } from "./types";
import { useLocationMutations, type GeneratedRow, type LevelSpec } from "./useLocationMutations";

interface Props {
  warehouseId: string | null;
  parent: LocationNode | null;
  /** Rendered under the preview — usually the commit button row. */
  onDone?: () => void;
  compact?: boolean;
}

function defaultSpec(level: StructureLevel): LevelSpec {
  return { level, count: level === "bin" ? 10 : 6, prefix: LEVEL[level].prefix, pad: 2 };
}

export function LocationRunBuilder({ warehouseId, parent, onDone, compact }: Props) {
  const rootOptions = childLevels(parent?.structure_level ?? null);
  const { generate, preview } = useLocationMutations(warehouseId);

  const [tiers, setTiers] = useState<LevelSpec[]>(() =>
    rootOptions[0] ? [defaultSpec(rootOptions[0])] : [],
  );
  const [serpentine, setSerpentine] = useState(true);
  const [barcodeAuto, setBarcodeAuto] = useState(true);
  const [capacity, setCapacity] = useState("");
  const [rows, setRows] = useState<GeneratedRow[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Reset when the parent changes — the legal levels change with it.
  useEffect(() => {
    const opts = childLevels(parent?.structure_level ?? null);
    setTiers(opts[0] ? [defaultSpec(opts[0])] : []);
    setRows([]);
  }, [parent?.id, parent?.structure_level]);

  const spec = useMemo(
    () => ({
      warehouseId: warehouseId ?? "",
      parentId: parent?.id ?? null,
      levels: tiers,
      serpentine,
      barcodeAuto,
      capacity: capacity.trim() === "" ? null : Number(capacity),
    }),
    [warehouseId, parent?.id, tiers, serpentine, barcodeAuto, capacity],
  );

  const valid =
    !!warehouseId && tiers.length > 0 && tiers.every((t) => t.count >= 1 && t.count <= 500);

  const runPreview = useCallback(async () => {
    if (!valid) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      setRows(await preview(spec));
    } catch (e) {
      setRows([]);
      setPreviewError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }, [preview, spec, valid]);

  useEffect(() => {
    const t = setTimeout(() => void runPreview(), 350);
    return () => clearTimeout(t);
  }, [runPreview]);

  const addTier = () => {
    const last = tiers[tiers.length - 1];
    const next = childLevels(last?.level ?? parent?.structure_level ?? null)[0];
    if (next) setTiers([...tiers, defaultSpec(next)]);
  };

  const setTier = (i: number, patch: Partial<LevelSpec>) =>
    setTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));

  const total = rows.length;
  const leafCount = tiers.reduce((a, t) => a * t.count, 1);

  if (rootOptions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing can be built inside {parent?.code ?? "here"} — bins are the smallest position in
        the warehouse.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {tiers.map((tier, i) => {
          const options = childLevels(
            i === 0 ? parent?.structure_level ?? null : tiers[i - 1].level,
          );
          return (
            <div key={i} className="grid grid-cols-2 items-end gap-2 @xl/page:grid-cols-6 @4xl/page:grid-cols-12 rounded-md border p-3">
              <div className="col-span-5 space-y-1">
                <Label>{i === 0 ? "Inside this location, add" : "And inside each, add"}</Label>
                <Select
                  value={tier.level}
                  onValueChange={(v) =>
                    setTier(i, { level: v as StructureLevel, prefix: LEVEL[v as StructureLevel].prefix })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((o) => (
                      <SelectItem key={o} value={o}>
                        {LEVEL[o].plural}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-1">
                <Label htmlFor={`tier-count-${i}`}>How many</Label>
                <Input
                  id={`tier-count-${i}`}
                  type="number"
                  min={1}
                  max={500}
                  value={tier.count}
                  onChange={(e) => setTier(i, { count: Math.max(1, Number(e.target.value) || 1) })}
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label htmlFor={`tier-prefix-${i}`}>Prefix</Label>
                <Input
                  id={`tier-prefix-${i}`}
                  value={tier.prefix}
                  onChange={(e) => setTier(i, { prefix: e.target.value.toUpperCase() })}
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label htmlFor={`tier-pad-${i}`}>Digits</Label>
                <Input
                  id={`tier-pad-${i}`}
                  type="number"
                  min={1}
                  max={4}
                  value={tier.pad}
                  onChange={(e) =>
                    setTier(i, { pad: Math.min(4, Math.max(1, Number(e.target.value) || 1)) })
                  }
                />
              </div>
              <div className="col-span-1 flex justify-end">
                {i === tiers.length - 1 && tiers.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove this tier"
                    onClick={() => setTiers(tiers.slice(0, -1))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <p className="col-span-12 text-xs text-muted-foreground">{LEVEL[tier.level].hint}</p>
            </div>
          );
        })}

        {childLevels(tiers[tiers.length - 1]?.level ?? null).length > 0 && (
          <Button variant="outline" size="sm" onClick={addTier}>
            <Plus className="mr-2 h-4 w-4" /> Go one level deeper
          </Button>
        )}
      </div>

      <div className="grid gap-2 @xl/page:grid-cols-2">
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label htmlFor="run-serp" className="font-normal">
              Snake walk order
            </Label>
            <p className="text-xs text-muted-foreground">
              Pickers finish one run and start the next from the near end.
            </p>
          </div>
          <Switch id="run-serp" checked={serpentine} onCheckedChange={setSerpentine} />
        </div>
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <Label htmlFor="run-barcode" className="font-normal">
              Label code = location code
            </Label>
            <p className="text-xs text-muted-foreground">
              Every position gets a scannable code, ready to print.
            </p>
          </div>
          <Switch id="run-barcode" checked={barcodeAuto} onCheckedChange={setBarcodeAuto} />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="run-capacity">Each bin holds up to (units)</Label>
        <Input
          id="run-capacity"
          type="number"
          min={0}
          placeholder="Leave empty if capacity isn't tracked"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
        />
      </div>

      <div className="rounded-md border bg-muted/40 p-3">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          {previewing ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> Working out the codes…
            </>
          ) : previewError ? (
            <span className="text-destructive">{previewError}</span>
          ) : (
            <>
              <Badge variant="secondary">{total || leafCount} positions</Badge>
              <span>will be created, in walk order</span>
            </>
          )}
        </div>
        <div className="flex max-h-40 flex-wrap gap-1 overflow-auto font-mono text-xs">
          {rows.slice(0, compact ? 24 : 120).map((r, i) => (
            <span key={`${r.code}-${i}`} className="rounded bg-background px-1.5 py-0.5">
              {r.code}
            </span>
          ))}
          {total > (compact ? 24 : 120) && (
            <span className="px-1 py-0.5">+{total - (compact ? 24 : 120)} more</span>
          )}
        </div>
      </div>

      <Button
        className="w-full"
        disabled={!valid || generate.isPending || previewing}
        onClick={async () => {
          await generate.mutateAsync(spec);
          onDone?.();
        }}
      >
        {generate.isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating…
          </>
        ) : (
          `Create ${total || leafCount} positions`
        )}
      </Button>
    </div>
  );
}
