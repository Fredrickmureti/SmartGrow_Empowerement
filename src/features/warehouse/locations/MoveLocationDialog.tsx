/**
 * MoveLocationDialog — re-parent a location with an explicit picker.
 *
 * Deliberately not drag-and-drop-only: supervisors work on touch screens
 * and need a deterministic control. Only parents that may legally hold this
 * level are offered; the database trigger is still the authority.
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { childLevels, levelLabel } from "./vocabulary";
import type { LocationNode } from "./types";
import { useLocationMutations } from "./useLocationMutations";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  warehouseId: string | null;
  node: LocationNode | null;
  /** Every location in this warehouse, depth-first. */
  ordered: LocationNode[];
}

export function MoveLocationDialog({ open, onOpenChange, warehouseId, node, ordered }: Props) {
  const { move } = useLocationMutations(warehouseId);
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<string | null>(null);

  const descendants = useMemo(() => {
    const out = new Set<string>();
    if (!node) return out;
    const walk = (n: LocationNode) => {
      out.add(n.id);
      n.children.forEach(walk);
    };
    walk(node);
    return out;
  }, [node]);

  const candidates = useMemo(() => {
    if (!node?.structure_level) return [];
    const q = search.trim().toLowerCase();
    return ordered.filter((c) => {
      if (descendants.has(c.id)) return false;
      if (c.id === node.parent_location_id) return false;
      if (!childLevels(c.structure_level ?? null).includes(node.structure_level!)) return false;
      if (!q) return true;
      return c.code.toLowerCase().includes(q) || (c.name ?? "").toLowerCase().includes(q);
    });
  }, [ordered, node, descendants, search]);

  const rootAllowed =
    !!node?.structure_level &&
    childLevels(null).includes(node.structure_level) &&
    node.parent_location_id !== null;

  if (!node) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Move {node.code}</DialogTitle>
          <DialogDescription>
            Choose where this {levelLabel(node.structure_level).toLowerCase()} sits. Everything
            inside it moves with it. Locations holding stock or open work can't be moved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="move-search">Search</Label>
          <Input
            id="move-search"
            value={search}
            placeholder="Code or description…"
            onChange={(e) => setSearch(e.target.value)}
          />
          <ScrollArea className="h-64 rounded-md border">
            <div className="p-1">
              {rootAllowed && (
                <Row
                  label="Top of the warehouse"
                  hint="Not inside anything else"
                  active={target === "__root__"}
                  onClick={() => setTarget("__root__")}
                />
              )}
              {candidates.map((c) => (
                <Row
                  key={c.id}
                  label={c.code}
                  hint={`${levelLabel(c.structure_level)}${c.path.length > 1 ? ` · ${c.path.slice(0, -1).join(" / ")}` : ""}`}
                  active={target === c.id}
                  onClick={() => setTarget(c.id)}
                />
              ))}
              {candidates.length === 0 && !rootAllowed && (
                <p className="p-3 text-sm text-muted-foreground">
                  Nowhere else in this warehouse can hold a{" "}
                  {levelLabel(node.structure_level).toLowerCase()}.
                </p>
              )}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!target || move.isPending}
            onClick={async () => {
              await move.mutateAsync({
                id: node.id,
                parentId: target === "__root__" ? null : target,
              });
              onOpenChange(false);
              setTarget(null);
            }}
          >
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full flex-col items-start rounded-md px-3 py-2 text-left hover:bg-muted",
        active && "bg-primary/10 ring-1 ring-primary",
      )}
    >
      <span className="font-mono text-sm">{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}
