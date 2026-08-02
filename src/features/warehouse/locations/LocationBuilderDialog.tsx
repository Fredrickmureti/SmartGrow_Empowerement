/**
 * LocationBuilderDialog — build a run of locations the way a warehouse
 * manager describes it: "aisle A, racks 1 to 12, four shelves each".
 *
 * All the structural rules (which level may sit inside which, code format,
 * serpentine walk order) live in `wms_generate_locations`; this dialog only
 * collects the intent and previews the resulting codes.
 */
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LEVEL, childLevels } from "./vocabulary";
import type { LocationNode, StructureLevel } from "./types";
import { useLocationMutations } from "./useLocationMutations";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  warehouseId: string | null;
  parent: LocationNode | null;
}

export function LocationBuilderDialog({ open, onOpenChange, warehouseId, parent }: Props) {
  const options = childLevels(parent?.structure_level ?? null);
  const [level, setLevel] = useState<StructureLevel>(options[0] ?? "zone");
  const [prefix, setPrefix] = useState("");
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(10);
  const [pad, setPad] = useState(2);
  const [serpentine, setSerpentine] = useState(true);
  const { generate } = useLocationMutations(warehouseId);

  const effectivePrefix = prefix || LEVEL[level]?.prefix || "";
  const preview = useMemo(() => {
    const out: string[] = [];
    for (let i = from; i <= Math.min(to, from + 200); i++) {
      out.push(`${parent ? parent.code + "-" : ""}${effectivePrefix}${String(i).padStart(pad, "0")}`);
    }
    return out;
  }, [from, to, pad, effectivePrefix, parent]);

  const count = Math.max(0, to - from + 1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {parent ? `Build inside ${parent.code}` : "Build the warehouse structure"}
          </DialogTitle>
          <DialogDescription>
            {options.length === 0
              ? "Nothing can be built inside this location — bins are the smallest position."
              : "Describe the run once; the system creates every position, its label code and its walk order."}
          </DialogDescription>
        </DialogHeader>

        {options.length > 0 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>What are you adding?</Label>
                <Select value={level} onValueChange={(v) => setLevel(v as StructureLevel)}>
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
                <p className="text-xs text-muted-foreground">{LEVEL[level]?.hint}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="builder-prefix">Code prefix</Label>
                <Input
                  id="builder-prefix"
                  value={prefix}
                  placeholder={LEVEL[level]?.prefix}
                  onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor="builder-from">From</Label>
                <Input
                  id="builder-from"
                  type="number"
                  value={from}
                  onChange={(e) => setFrom(Number(e.target.value) || 1)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="builder-to">To</Label>
                <Input
                  id="builder-to"
                  type="number"
                  value={to}
                  onChange={(e) => setTo(Number(e.target.value) || 1)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="builder-pad">Digits</Label>
                <Input
                  id="builder-pad"
                  type="number"
                  min={1}
                  max={4}
                  value={pad}
                  onChange={(e) => setPad(Math.min(4, Math.max(1, Number(e.target.value) || 1)))}
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="builder-serp" className="font-normal">
                  Walk them in a snake pattern
                </Label>
                <p className="text-xs text-muted-foreground">
                  Pickers finish one run and start the next from the near end — no walking back.
                </p>
              </div>
              <Switch id="builder-serp" checked={serpentine} onCheckedChange={setSerpentine} />
            </div>

            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-1 text-xs text-muted-foreground">
                {count} location{count === 1 ? "" : "s"} will be created
              </div>
              <div className="flex flex-wrap gap-1 font-mono text-xs">
                {preview.slice(0, 12).map((c) => (
                  <span key={c} className="rounded bg-background px-1.5 py-0.5">
                    {c}
                  </span>
                ))}
                {count > 12 && <span className="px-1 py-0.5">+{count - 12} more</span>}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={options.length === 0 || count < 1 || generate.isPending || !warehouseId}
            onClick={async () => {
              await generate.mutateAsync({
                warehouseId: warehouseId!,
                parentId: parent?.id ?? null,
                level,
                prefix: effectivePrefix,
                from,
                to,
                pad,
                serpentine,
              });
              onOpenChange(false);
            }}
          >
            Create {count}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
