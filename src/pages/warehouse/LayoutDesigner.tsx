/**
 * LayoutDesigner — the full-screen authoring surface for a warehouse's
 * physical structure (ADR 0104, Phase 3).
 *
 * Left: the structure as it exists today, so the supervisor always sees
 * what they are building into. Right: the run builder with a live preview
 * of the exact codes and walk order the database will create.
 *
 * No dialogs: authoring a 2,000-bin warehouse is a task, not a modal.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Building2, Search } from "lucide-react";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useWarehouseLocations } from "@/features/warehouse/locations/useWarehouseLocations";
import { LocationStructureTree } from "@/features/warehouse/locations/LocationStructureTree";
import { LocationRunBuilder } from "@/features/warehouse/locations/LocationRunBuilder";
import { levelLabel } from "@/features/warehouse/locations/vocabulary";
import type { LocationNode } from "@/features/warehouse/locations/types";

export default function LayoutDesigner() {
  const [params] = useSearchParams();
  const requestedWarehouse = params.get("warehouse");
  const requestedParent = params.get("parent");

  const { warehouses, isLoading: whLoading } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState<string | null>(requestedWarehouse);
  const activeWarehouseId = warehouseId ?? warehouses[0]?.id ?? null;

  const { roots, ordered, byId, isLoading } = useWarehouseLocations(activeWarehouseId);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(requestedParent);
  const [search, setSearch] = useState("");

  // Arriving from the floor with "build inside X": select it and open the
  // path down to it so the supervisor sees where they are building.
  useEffect(() => {
    if (!requestedParent) return;
    const node = byId.get(requestedParent);
    if (!node) return;
    setSelectedId(requestedParent);
    setExpanded((prev) => {
      const next = new Set(prev);
      let cur: LocationNode | null = node;
      while (cur) {
        next.add(cur.id);
        cur = cur.parent_location_id ? byId.get(cur.parent_location_id) ?? null : null;
      }
      return next;
    });
  }, [requestedParent, byId]);

  const parent: LocationNode | null = selectedId ? byId.get(selectedId) ?? null : null;

  const filter = useMemo(
    () => (n: LocationNode) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return n.code.toLowerCase().includes(q) || (n.name ?? "").toLowerCase().includes(q);
    },
    [search],
  );


  if (whLoading) return <LoadingState />;

  if (warehouses.length === 0) {
    return (
      <PageBody>
        <EmptyState
          title="No warehouse yet"
          description="Create a warehouse first — a layout describes what is inside a building."
        />
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        title="Layout designer"
        description="Lay out zones, aisles, racks, shelves and bins — with their label codes and walk order — before anyone sets foot on the floor."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={activeWarehouseId ?? undefined}
              onValueChange={(v) => {
                setWarehouseId(v);
                setSelectedId(null);
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Choose a warehouse" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" asChild>
              <Link to="/warehouse-app/layout">
                <ArrowLeft className="mr-2 h-4 w-4" /> Back to the floor
              </Link>
            </Button>
          </div>
        }
      />

      <PageBody>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Card className="flex h-[calc(100vh-16rem)] min-h-[28rem] flex-col overflow-hidden">
            <div className="border-b p-2">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Find where to build…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className={`flex items-center gap-2 border-b px-3 py-2 text-left text-sm hover:bg-muted ${
                selectedId === null ? "bg-primary/10" : ""
              }`}
            >
              <Building2 className="h-4 w-4" />
              Top of the warehouse
            </button>
            <div className="min-h-0 flex-1">
              {isLoading ? (
                <LoadingState />
              ) : ordered.length === 0 ? (
                <EmptyState
                  title="Nothing built yet"
                  description="Start at the top of the warehouse and add your first zones."
                />
              ) : (
                <LocationStructureTree
                  roots={roots}
                  expanded={expanded}
                  onToggle={(id) =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  selectedId={selectedId}
                  onSelect={(n) => setSelectedId(n.id)}
                  filter={filter}
                />
              )}
            </div>
          </Card>

          <Card className="h-[calc(100vh-16rem)] min-h-[28rem] overflow-auto p-4">
            <div className="mb-4">
              <h2 className="text-lg font-semibold">
                {parent
                  ? `Building inside ${parent.code}`
                  : "Building at the top of the warehouse"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {parent
                  ? `${levelLabel(parent.structure_level)}${parent.name && parent.name !== parent.code ? ` · ${parent.name}` : ""}`
                  : "Zones, docks and staging areas sit here."}
              </p>
            </div>
            <LocationRunBuilder warehouseId={activeWarehouseId} parent={parent} />
          </Card>
        </div>
      </PageBody>
    </>
  );
}
