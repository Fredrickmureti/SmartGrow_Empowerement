/**
 * License Plates — WMS handling-unit control tower (ADR 0079).
 *
 * Not a CRUD list: this is the operational surface operators live in.
 * Scan a plate barcode to jump straight to its cockpit, watch occupancy
 * and stock-bearing state at a glance, and drive bulk label printing and
 * consolidation without leaving the board.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader, PageBody, Section, LoadingState, EmptyState, StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { PackageOpen, Plus, Search, Printer, Layers, ScanLine } from "lucide-react";
import { useWmsScanIntent } from "@/features/warehouse/scanning/wmsScanIntent";
import {
  useLpnOverview, useLpnAction, resolveLpnByCode, nextLpnCode, useLpnStatusCatalog,
  type LpnOverviewRow, type LpnType,
} from "@/features/warehouse/lpn/useLpnOps";
import { LpnLabelDialog } from "@/features/warehouse/lpn/LpnLabelDialog";
import { HandlingUnitPreview } from "@/features/warehouse/lpn/HandlingUnitPreview";
import { EntityPreviewEmpty } from "@/features/warehouse/entity/EntityPreview";
import { useEntitySelection } from "@/features/warehouse/entity/useEntitySelection";

const STATUS_TONE: Record<string, "success" | "warning" | "info" | "neutral" | "danger"> = {
  open: "info",
  sealed: "warning",
  shipped: "success",
  retired: "neutral",
  voided: "danger",
  consumed: "neutral",
};

function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export default function LicensePlates() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { warehouses } = useWarehouses();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { user } = useAuth();

  const [warehouseFilter, setWarehouseFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  // Peek-before-navigate (ADR 0122): the row opens a read-only preview; the
  // plate cockpit stays one click away.
  const [previewId, setPreviewId] = useEntitySelection();

  const { data: rows, isLoading } = useLpnOverview({
    businessId: currentBusiness?.id,
    warehouseId: warehouseFilter,
    type: typeFilter,
    status: statusFilter,
  });
  // Status vocabulary comes from the FSM rulebook, never a hardcoded list.
  const { data: statuses } = useLpnStatusCatalog();

  // Scan a plate barcode anywhere on this board → open its cockpit.
  useWmsScanIntent({
    intent: "putaway.lpn",
    label: "lpn-board",
    onScan: async (payload) => {
      if (!currentBusiness?.id) return;
      const plate = await resolveLpnByCode(currentBusiness.id, payload.resolveCode);
      if (!plate) {
        toast.error(`No plate matches ${payload.resolveCode}`);
        return;
      }
      nav(`/warehouse-app/plates/${plate.id}`);
    },
  });

  const filtered = useMemo(() => {
    const list = rows ?? [];
    const s = search.trim().toLowerCase();
    if (!s) return list;
    return list.filter(
      (r) =>
        r.code.toLowerCase().includes(s) ||
        (r.location_code ?? "").toLowerCase().includes(s) ||
        (r.location_path ?? "").toLowerCase().includes(s),
    );
  }, [rows, search]);

  const metrics = useMemo(() => {
    const list = rows ?? [];
    return {
      total: list.length,
      stocked: list.filter((r) => Number(r.total_quantity) > 0).length,
      empty: list.filter((r) => Number(r.total_quantity) === 0).length,
      sealed: list.filter((r) => r.status === "sealed").length,
      unlocated: list.filter((r) => !r.current_location_id).length,
      units: list.reduce((a, r) => a + Number(r.total_quantity || 0), 0),
    };
  }, [rows]);

  const mergeTarget = selected[0];
  const mergeAction = useLpnAction(mergeTarget);

  const [labelOpen, setLabelOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ code: "", lpn_type: "pallet" as LpnType, warehouse_id: "" });

  const create = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id || !currentOrg?.id) throw new Error("No active organization");
      if (!form.warehouse_id) throw new Error("Choose a warehouse");
      const wh = warehouses.find((w) => w.id === form.warehouse_id);
      const code = form.code.trim() || (await nextLpnCode(currentBusiness.id, form.warehouse_id, form.lpn_type));
      const { data, error } = await supabase
        .from("wms_license_plates")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          branch_id: wh?.branch_id ?? null,
          warehouse_id: form.warehouse_id,
          code,
          lpn_type: form.lpn_type,
          created_by: user?.id ?? null,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (id) => {
      toast.success("Plate created");
      setCreateOpen(false);
      setForm({ code: "", lpn_type: "pallet", warehouse_id: "" });
      qc.invalidateQueries({ queryKey: ["wms-lpns"] });
      nav(`/warehouse-app/plates/${id}`);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Create failed"),
  });

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  return (
    <>
      <PageHeader
        title="Handling units"
        description="License plates carrying stock through the warehouse — scan, move, consolidate, label."
        actions={
          <div className="flex flex-wrap gap-2">
            {selected.length > 0 && (
              <>
                <Button variant="outline" onClick={() => setLabelOpen(true)}>
                  <Printer className="mr-2 h-4 w-4" /> Print {selected.length}
                </Button>
                <Button
                  variant="outline"
                  disabled={selected.length < 2 || mergeAction.isPending}
                  onClick={() => {
                    // The merge target's revision must travel with the call:
                    // wms_lpn_merge rejects a missing version (Phase 6).
                    const target = (rows ?? []).find((r) => r.id === mergeTarget);
                    if (!target) return;
                    mergeAction.run(
                      { kind: "merge", sourceIds: selected.slice(1), expectedVersion: target.row_version },
                      { onSuccess: () => setSelected([]) },
                    );
                  }}
                >
                  <Layers className="mr-2 h-4 w-4" /> Merge into {(rows ?? []).find((r) => r.id === mergeTarget)?.code}
                </Button>
              </>
            )}
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> New plate
            </Button>
          </div>
        }
      />
      <PageBody>
        <div className="min-w-0 grid gap-3 @xl/page:grid-cols-2 @4xl/page:grid-cols-5">
          <Metric label="Plates" value={metrics.total} />
          <Metric label="Carrying stock" value={metrics.stocked} hint={`${metrics.units.toLocaleString()} units`} />
          <Metric label="Empty" value={metrics.empty} hint="Available to build" />
          <Metric label="Sealed" value={metrics.sealed} hint="Ready to ship" />
          <Metric label="Unlocated" value={metrics.unlocated} hint="No bin assigned" />
        </div>

        <div className="min-w-0 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <Section
          title="Board"
          description="Scan a plate barcode at any time to open its cockpit."
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="relative min-w-[220px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Search plate or bin code"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                <SelectTrigger className="w-full @xl/page:w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All warehouses</SelectItem>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-full @xl/page:w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="pallet">Pallet</SelectItem>
                  <SelectItem value="carton">Carton</SelectItem>
                  <SelectItem value="tote">Tote</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full @xl/page:w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {(statuses ?? []).map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Badge variant="outline" className="gap-1">
                <ScanLine className="h-3 w-3" /> Scanner armed
              </Badge>
            </div>

            {isLoading ? (
              <LoadingState />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={PackageOpen}
                title="No plates match"
                description="Adjust the filters or build a new handling unit."
                action={<Button onClick={() => setCreateOpen(true)}>New plate</Button>}
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead>Plate</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead className="text-right">SKUs</TableHead>
                      <TableHead className="text-right">Units</TableHead>
                      <TableHead className="text-right">Nested</TableHead>
                      <TableHead>Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((r: LpnOverviewRow) => (
                      <TableRow
                        key={r.id}
                        onClick={() => setPreviewId(r.id)}
                        data-state={previewId === r.id ? "selected" : undefined}
                        className="cursor-pointer"
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selected.includes(r.id)}
                            onCheckedChange={() => toggle(r.id)}
                          />
                        </TableCell>
                        <TableCell>
                          <Link
                            to={`/warehouse-app/plates/${r.id}`}
                            className="font-mono font-medium hover:underline"
                          >
                            {r.code}
                          </Link>
                          {r.parent_lpn_id && (
                            <Badge variant="secondary" className="ml-2">nested</Badge>
                          )}
                        </TableCell>
                        <TableCell className="capitalize">{r.lpn_type}</TableCell>
                        <TableCell>
                          <StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>
                            {r.status}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {r.location_code ? (
                            <>
                              <div>{r.location_code}</div>
                              {r.location_path && r.location_path !== r.location_code && (
                                <div className="text-[11px] text-muted-foreground">{r.location_path}</div>
                              )}
                            </>
                          ) : (
                            <span className="text-muted-foreground">Unlocated</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{Number(r.sku_count ?? 0)}</TableCell>
                        <TableCell className="text-right tabular-nums">{Number(r.total_quantity ?? 0)}</TableCell>
                        <TableCell className="text-right tabular-nums">{Number(r.child_count ?? 0)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(r.updated_at).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </Section>

        <Section contentClassName="p-0" className="min-w-0">
          {(() => {
            const row = (rows ?? []).find((r) => r.id === previewId);
            return row ? (
              <HandlingUnitPreview row={row} />
            ) : (
              <EntityPreviewEmpty
                title="Select a handling unit"
                description="Pick a plate to see what it carries and where it stands. Building, sealing and moving happen in the plate cockpit."
              />
            );
          })()}
        </Section>
        </div>
      </PageBody>

      <LpnLabelDialog
        open={labelOpen}
        onOpenChange={setLabelOpen}
        orgId={currentOrg?.id}
        plates={(rows ?? []).filter((r) => selected.includes(r.id))}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New license plate</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Warehouse</Label>
              <Select
                value={form.warehouse_id}
                onValueChange={(v) => setForm((f) => ({ ...f, warehouse_id: v }))}
              >
                <SelectTrigger><SelectValue placeholder="Choose warehouse" /></SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={form.lpn_type}
                onValueChange={(v) => setForm((f) => ({ ...f, lpn_type: v as LpnType }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pallet">Pallet</SelectItem>
                  <SelectItem value="carton">Carton</SelectItem>
                  <SelectItem value="tote">Tote</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Code</Label>
              <Input
                placeholder="Leave blank for the next sequential code"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
