/**
 * WarehouseLayoutWorkspace — the digital twin of the physical building.
 *
 * Three panes:
 *   • Structure — walk the warehouse zone → aisle → rack → shelf → bin.
 *   • Floor     — a spatial grid colour-coded by what's actually happening.
 *   • Inspector — one position: its stock, its open work, its behaviour,
 *                 its label.
 *
 * Reads come from `useWarehouseLocations` (master + `wms_location_overview`
 * operational rollup). Scans go through `resolve_location_identity`, the
 * single location resolver seam — no surface queries barcodes directly.
 *
 * Replaces the legacy CRUD tree (ADR 0079 Phase 0). See ADR 0104.
 */
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Printer, Plus, ScanLine, RefreshCw, Search, PencilRuler } from "lucide-react";

import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useBranches } from "@/hooks/useBranches";
import { useWarehouseLocations } from "@/features/warehouse/locations/useWarehouseLocations";
import { useResolveLocationIdentity } from "@/features/warehouse/locations/useResolveLocationIdentity";
import { LocationStructureTree } from "@/features/warehouse/locations/LocationStructureTree";
import { LocationMap } from "@/features/warehouse/locations/LocationMap";
import { LocationInspector } from "@/features/warehouse/locations/LocationInspector";
import { LocationBuilderDialog } from "@/features/warehouse/locations/LocationBuilderDialog";
import { MoveLocationDialog } from "@/features/warehouse/locations/MoveLocationDialog";

import { BinLabelDialog } from "@/features/warehouse/locations/BinLabelDialog";
import { LabelVerifyDialog } from "@/features/warehouse/locations/LabelVerifyDialog";
import {
  LocationTable,
  matchesTableFilter,
  type TableFilter,
} from "@/features/warehouse/locations/LocationTable";
import { useLocationMutations } from "@/features/warehouse/locations/useLocationMutations";
import type { LocationNode } from "@/features/warehouse/locations/types";
import { useWmsScanIntent } from "@/features/warehouse/scanning/wmsScanIntent";

export default function WarehouseLayoutWorkspace() {
  const { warehouses, isLoading: whLoading } = useWarehouses();
  const { currentBranch } = useBranches();
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const activeWarehouseId = warehouseId ?? warehouses[0]?.id ?? null;

  const { roots, ordered, byId, byCode, isLoading, refetch } =
    useWarehouseLocations(activeWarehouseId);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [builderParent, setBuilderParent] = useState<LocationNode | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [labelTargets, setLabelTargets] = useState<LocationNode[] | null>(null);
  const [moveTarget, setMoveTarget] = useState<LocationNode | null>(null);
  const [tableFilter, setTableFilter] = useState<TableFilter>("bins");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [verifyOpen, setVerifyOpen] = useState(false);

  const { assignBarcodes } = useLocationMutations(activeWarehouseId);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const { resolve, resolution } = useResolveLocationIdentity(activeWarehouseId);


  const revealPath = useCallback(
    (node: LocationNode) => {
      const next = new Set(expanded);
      let cur: LocationNode | undefined = node;
      while (cur?.parent_location_id) {
        next.add(cur.parent_location_id);
        cur = byId.get(cur.parent_location_id);
      }
      setExpanded(next);
      setSelectedId(node.id);
      setFocusId(node.parent_location_id);
    },
    [expanded, byId],
  );

  // Scan a bin label anywhere on this screen and the workspace jumps to it.
  useWmsScanIntent({
    intent: "pick.location",
    label: "layout.locate",
    onScan: async ({ resolveCode }) => {
      const result = await resolve(resolveCode);
      if (result.status === "ok" && result.location) {
        const node = byId.get(result.location.location_id);
        if (node) revealPath(node);
      }
    },
  });

  const filter = useCallback(
    (n: LocationNode) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (
        n.code.toLowerCase().includes(q) ||
        (n.name ?? "").toLowerCase().includes(q) ||
        (n.barcode ?? "").toLowerCase().includes(q)
      );
    },
    [search],
  );

  const stats = useMemo(() => {
    const bins = ordered.filter((n) => n.structure_level === "bin");
    const stocked = bins.filter((b) => b.metrics.on_hand_units > 0).length;
    const blocked = ordered.filter((n) => !n.is_active).length;
    const work = ordered.reduce((a, n) => a + (n.children.length ? 0 : n.metrics.open_tasks), 0);
    const unlabelled = bins.filter((b) => !b.barcode).length;
    return { total: ordered.length, bins: bins.length, stocked, blocked, work, unlabelled };
  }, [ordered]);

  // Rows for the table pane: the search box narrows, the view select shapes.
  const tableRows = useMemo(
    () => ordered.filter((n) => filter(n) && matchesTableFilter(n, tableFilter)),
    [ordered, filter, tableFilter],
  );

  const pickedNodes = useMemo(
    () => ordered.filter((n) => picked.has(n.id)),
    [ordered, picked],
  );

  const togglePicked = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const togglePickedMany = useCallback((ids: string[], select: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (select ? next.add(id) : next.delete(id)));
      return next;
    });
  }, []);


  if (whLoading) return <LoadingState />;

  if (warehouses.length === 0) {
    return (
      <PageBody>
        <EmptyState
          title="No warehouse yet"
          description="Create a warehouse first — the layout describes what's inside a building."
        />
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        title="Warehouse layout"
        description="Every zone, aisle, rack, shelf and bin — with what's in it and what's happening right now."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={activeWarehouseId ?? undefined}
              onValueChange={(v) => {
                setWarehouseId(v);
                setSelectedId(null);
                setFocusId(null);
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
            <Button variant="outline" size="icon" onClick={refetch} aria-label="Refresh">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              onClick={() => setLabelTargets(ordered.filter((n) => n.structure_level === "bin"))}
              disabled={stats.bins === 0}
            >
              <Printer className="mr-2 h-4 w-4" /> Print all bin labels
            </Button>
            <Button
              variant="outline"
              onClick={() => setVerifyOpen(true)}
              disabled={stats.bins === 0}
            >
              <ScanLine className="mr-2 h-4 w-4" /> Verify labels
            </Button>
            <Button variant="outline" asChild>
              <Link to="/warehouse-app/layout/design">
                <PencilRuler className="mr-2 h-4 w-4" /> Layout designer
              </Link>
            </Button>


            <Button
              onClick={() => {
                setBuilderParent(selected);
                setBuilderOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              {selected ? `Build inside ${selected.code}` : "Build structure"}
            </Button>
          </div>
        }
      />

      <PageBody>
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-6">
          <Stat label="Locations" value={stats.total} />
          <Stat label="Bins" value={stats.bins} />
          <Stat label="Bins holding stock" value={stats.stocked} />
          <Stat
            label="Bins without a label"
            value={stats.unlabelled}
            tone={stats.unlabelled ? "danger" : undefined}
          />
          <Stat label="Blocked" value={stats.blocked} tone={stats.blocked ? "danger" : undefined} />
          <Stat label="Open jobs" value={stats.work} />
        </div>


        <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Card className="flex h-[calc(100vh-20rem)] min-h-[28rem] flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b p-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Find a code, description or label…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <ScanIndicator status={resolution.status} message={resolution.message} />
            </div>

            <Tabs defaultValue="structure" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="m-2 w-fit">
                <TabsTrigger value="structure">Structure</TabsTrigger>
                <TabsTrigger value="floor">Floor</TabsTrigger>
              </TabsList>
              <TabsContent value="structure" className="m-0 min-h-0 flex-1">
                {isLoading ? (
                  <LoadingState />
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
              </TabsContent>
              <TabsContent value="floor" className="m-0 min-h-0 flex-1">
                <LocationMap
                  roots={roots}
                  focusId={focusId}
                  byId={byId}
                  onFocus={setFocusId}
                  selectedId={selectedId}
                  onSelect={(n) => setSelectedId(n.id)}
                />
              </TabsContent>
            </Tabs>
          </Card>

          <Card className="h-[calc(100vh-20rem)] min-h-[28rem] overflow-hidden">
            <LocationInspector
              node={selected}
              warehouseId={activeWarehouseId}
              onPrintLabel={setLabelTargets}
              onAddInside={(parent) => {
                setBuilderParent(parent);
                setBuilderOpen(true);
              }}
              onMove={(n) => setMoveTarget(n)}
            />
          </Card>
        </div>
      </PageBody>

      <LocationBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        warehouseId={activeWarehouseId}
        parent={builderParent}
      />
      <MoveLocationDialog
        open={!!moveTarget}
        onOpenChange={(v) => !v && setMoveTarget(null)}
        warehouseId={activeWarehouseId}
        node={moveTarget}
        ordered={ordered}
      />

      <BinLabelDialog
        open={!!labelTargets}
        onOpenChange={(v) => !v && setLabelTargets(null)}
        locations={labelTargets ?? []}
        warehouseId={activeWarehouseId}
        branchId={currentBranch?.id ?? null}
      />
    </>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger";
}) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-xl font-semibold", tone === "danger" && "text-destructive")}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function ScanIndicator({ status, message }: { status: string; message: string | null }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs",
        status === "ok" && "border-primary text-primary",
        (status === "not_found" || status === "ambiguous" || status === "error") &&
          "border-destructive text-destructive",
      )}
      title={message ?? "Scan a bin label to jump straight to it"}
    >
      <ScanLine className="h-4 w-4" />
      <span className="hidden sm:inline">
        {status === "idle" ? "Scan to locate" : message ?? "Located"}
      </span>
    </div>
  );
}
