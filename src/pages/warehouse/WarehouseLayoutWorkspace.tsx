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
import { Link, useNavigate } from "react-router-dom";
import { Printer, Plus, ScanLine, RefreshCw, Search, PencilRuler, Barcode } from "lucide-react";

import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { LocationPreview } from "@/features/warehouse/locations/LocationPreview";
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
import { ScanCameraButton } from "@/components/scanner/ScanCameraButton";
import { useEntitySelection } from "@/features/warehouse/entity/useEntitySelection";

/** Deep-link into the full-page structure builder (no modal, no lost work). */
function buildHref(warehouseId: string | null, parentId: string | null) {
  const q = new URLSearchParams();
  if (warehouseId) q.set("warehouse", warehouseId);
  if (parentId) q.set("parent", parentId);
  const s = q.toString();
  return `/warehouse-app/layout/design${s ? `?${s}` : ""}`;
}

export default function WarehouseLayoutWorkspace() {
  const navigate = useNavigate();
  const { warehouses, isLoading: whLoading } = useWarehouses();
  const { currentBranch } = useBranches();

  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const activeWarehouseId = warehouseId ?? warehouses[0]?.id ?? null;

  const { roots, ordered, byId, byCode, isLoading, refetch } =
    useWarehouseLocations(activeWarehouseId);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useEntitySelection();
  const [focusId, setFocusId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
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

  // Bin-level tooling (labels, verification) only has meaning once bins exist.
  const binActionReason =
    isLoading
      ? "Loading locations…"
      : stats.bins === 0
        ? "No bin-level locations in this warehouse yet — build the structure first."
        : null;

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
            <BinActionButton
              disabledReason={binActionReason}
              onClick={() => setLabelTargets(ordered.filter((n) => n.structure_level === "bin"))}
            >
              <Printer className="mr-2 h-4 w-4" /> Print all bin labels
            </BinActionButton>
            <BinActionButton
              disabledReason={binActionReason}
              onClick={() => setVerifyOpen(true)}
            >
              <ScanLine className="mr-2 h-4 w-4" /> Verify labels
            </BinActionButton>
            <Button variant="outline" asChild>
              <Link to={buildHref(activeWarehouseId, null)}>
                <PencilRuler className="mr-2 h-4 w-4" /> Layout designer
              </Link>
            </Button>


            <Button asChild>
              <Link to={buildHref(activeWarehouseId, selected?.id ?? null)}>
                <Plus className="mr-2 h-4 w-4" />
                {selected ? `Build inside ${selected.code}` : "Build structure"}
              </Link>
            </Button>

          </div>
        }
      />

      <PageBody>
        {!isLoading && stats.bins === 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">This warehouse has no bins yet</p>
              <p className="text-xs text-muted-foreground">
                Bins are the addressable slots stock is put away into. Build zones, aisles, racks
                and shelves in the layout designer — label printing and verification unlock as soon
                as the first bin exists.
              </p>
            </div>
            <Button asChild size="sm" className="shrink-0">
              <Link to={buildHref(activeWarehouseId, selected?.id ?? null)}>
                <PencilRuler className="mr-2 h-4 w-4" /> Build structure
              </Link>
            </Button>
          </div>
        )}

        <div className="min-w-0 mb-3 grid grid-cols-2 gap-2 @xl/page:grid-cols-6">
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
              {/* Handheld: no wedge gun on a phone — the layout scan intent
                  above receives whatever the camera decodes. */}
              <ScanCameraButton label="Scan a bin label" />
              <ScanIndicator status={resolution.status} message={resolution.message} />

            </div>

            <Tabs defaultValue="structure" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="m-2 w-fit">
                <TabsTrigger value="structure">Structure</TabsTrigger>
                <TabsTrigger value="floor">Floor</TabsTrigger>
                <TabsTrigger value="table">Table</TabsTrigger>
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
              <TabsContent value="table" className="m-0 flex min-h-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
                  <Select
                    value={tableFilter}
                    onValueChange={(v) => setTableFilter(v as TableFilter)}
                  >
                    <SelectTrigger className="h-8 w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bins">Bins only</SelectItem>
                      <SelectItem value="all">Everything</SelectItem>
                      <SelectItem value="stocked">Holding stock</SelectItem>
                      <SelectItem value="empty">Empty and open</SelectItem>
                      <SelectItem value="busy">Has open work</SelectItem>
                      <SelectItem value="unlabelled">No label yet</SelectItem>
                      <SelectItem value="blocked">Blocked</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {tableRows.length.toLocaleString()} shown
                  </span>
                  {picked.size > 0 && (
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-xs font-medium">
                        {picked.size.toLocaleString()} selected
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          assignBarcodes.mutate(
                            pickedNodes
                              .filter((n) => !n.barcode)
                              .map((n) => ({ id: n.id, barcode: n.code })),
                          )
                        }
                        disabled={
                          assignBarcodes.isPending ||
                          pickedNodes.every((n) => !!n.barcode)
                        }
                      >
                        <Barcode className="mr-2 h-4 w-4" /> Make scannable
                      </Button>
                      <Button size="sm" onClick={() => setLabelTargets(pickedNodes)}>
                        <Printer className="mr-2 h-4 w-4" /> Print labels
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                        Clear
                      </Button>
                    </div>
                  )}
                </div>
                {isLoading ? (
                  <LoadingState />
                ) : (
                  <LocationTable
                    rows={tableRows}
                    selected={picked}
                    onToggle={togglePicked}
                    onToggleAll={togglePickedMany}
                    selectedId={selectedId}
                    onSelect={(n) => setSelectedId(n.id)}
                  />
                )}
              </TabsContent>
            </Tabs>

          </Card>

          <Card className="h-[calc(100vh-20rem)] min-h-[28rem] overflow-hidden">
            <LocationPreview
              node={selected}
              warehouseId={activeWarehouseId}
              onPrintLabel={setLabelTargets}
              onAddInside={(parent) =>
                navigate(buildHref(activeWarehouseId, parent?.id ?? null))
              }
              onMove={(n) => setMoveTarget(n)}
            />
          </Card>
        </div>
      </PageBody>


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

      <LabelVerifyDialog
        open={verifyOpen}
        onOpenChange={setVerifyOpen}
        warehouseId={activeWarehouseId}
        expected={ordered.filter((n) => n.structure_level === "bin")}
        onReprint={setLabelTargets}
      />
    </>
  );
}

function BinActionButton({
  disabledReason,
  onClick,
  children,
}: {
  disabledReason: string | null;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const button = (
    <Button variant="outline" onClick={onClick} disabled={!!disabledReason}>
      {children}
    </Button>
  );
  if (!disabledReason) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-not-allowed">{button}</span>
      </TooltipTrigger>
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
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
