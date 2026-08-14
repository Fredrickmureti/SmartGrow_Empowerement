/**
 * License Plate cockpit — one handling unit, everything an operator can
 * do with it (ADR 0079).
 *
 * Contents come from `stock_quants.lpn_id` (plates are inventory-bearing),
 * and every action is an atomic RPC: move relocates the stock with the
 * plate, load/unload transfers between bin and plate, split/merge/nest
 * restructure handling units. The event ledger below is the plate's own
 * `wms_lpn_events` audit trail.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader, PageBody, Section, LoadingState, EmptyState, StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScanTextField } from "@/components/scanner/ScanTextField";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  PackageOpen, ArrowLeft, MoveRight, Printer,
  Download, Upload, Split, Link2, Unlink, ScanLine,
} from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { LpnLabelDialog } from "@/features/warehouse/lpn/LpnLabelDialog";
import { LpnLifecycleRail } from "@/features/warehouse/lpn/LpnLifecycleRail";
import { ActivitySection } from "@/features/warehouse/events/ActivitySection";
import { useWmsScanIntent } from "@/features/warehouse/scanning/wmsScanIntent";
import { useWarehouseQtyFormatter, WarehouseQty, AggregateQty } from "@/features/warehouse/quantity/warehouseQty";
import {
  unitOptionsFor, optionByKey, toBaseUnits, BASE_UNIT_KEY,
} from "@/features/warehouse/receiving/receivingUnits";
import {
  useLpn, useLpnContents, useLpnChildren, useLpnEvents, useLpnAction,
  resolveLpnByCode, useBinLooseStock,
} from "@/features/warehouse/lpn/useLpnOps";

const STATUS_TONE: Record<string, "success" | "warning" | "info" | "neutral" | "danger"> = {
  open: "info", sealed: "warning", shipped: "success",
  retired: "neutral", voided: "danger", consumed: "neutral",
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

export default function LicensePlateView() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const { data: lpn, isLoading } = useLpn(id);
  const { data: contents } = useLpnContents(id);
  const { data: children } = useLpnChildren(id);
  const { data: events } = useLpnEvents(id);
  const action = useLpnAction(id);
  // Load can only draw from unassigned stock in the plate's own bin.
  const { data: binStock } = useBinLooseStock(lpn?.current_location_id);

  const { data: locations } = useQuery({
    queryKey: ["wms-lpn-loc-options", lpn?.warehouse_id],
    enabled: !!lpn?.warehouse_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id, code, name")
        .eq("warehouse_id", lpn!.warehouse_id)
        .eq("is_active", true)
        .order("code");
      if (error) throw error;
      return data ?? [];
    },
  });

  const [dialog, setDialog] = useState<null | "move" | "load" | "unload" | "split" | "nest">(null);
  const [labelOpen, setLabelOpen] = useState(false);
  const [moveDest, setMoveDest] = useState("");
  const [moveNote, setMoveNote] = useState("");
  const [line, setLine] = useState({ productId: "", quantity: "1", unitKey: BASE_UNIT_KEY, lot: "", serial: "" });
  const [splitLines, setSplitLines] = useState<Record<string, string>>({});
  const [splitUnits, setSplitUnits] = useState<Record<string, string>>({});
  const [parentCode, setParentCode] = useState("");

  // One packaging fetch for every product on screen. Quantities are rendered
  // through the shared formatter — a warehouse screen never prints a naked
  // base-unit number (see `warehouseQty`).
  const qtyFmt = useWarehouseQtyFormatter([
    ...(contents ?? []).map((c) => c.product_id),
    ...(binStock ?? []).map((c) => c.product_id),
  ]);

  // Scanning: a bin scan while the move dialog is open picks the bin; a
  // plate scan while nesting picks the parent. Otherwise a plate scan
  // navigates to that plate.
  useWmsScanIntent({
    intent: "putaway.bin",
    priority: 30,
    enabled: dialog === "move",
    label: "lpn-move-bin",
    onScan: (p) => {
      const bin = (locations ?? []).find(
        (l) => l.code.toLowerCase() === p.resolveCode.trim().toLowerCase(),
      );
      if (!bin) return toast.error(`No bin ${p.resolveCode} in this warehouse`);
      setMoveDest(bin.id);
      toast.success(`Destination ${bin.code}`);
    },
  });

  useWmsScanIntent({
    intent: "putaway.lpn",
    label: "lpn-cockpit",
    enabled: dialog !== "move",
    onScan: async (p) => {
      if (!currentBusiness?.id) return;
      if (dialog === "nest") {
        setParentCode(p.resolveCode);
        return;
      }
      const plate = await resolveLpnByCode(currentBusiness.id, p.resolveCode);
      if (!plate) return toast.error(`No plate ${p.resolveCode}`);
      if (plate.id !== id) nav(`/warehouse-app/plates/${plate.id}`);
    },
  });

  const totals = useMemo(() => {
    const list = contents ?? [];
    return {
      skus: list.length,
      units: list.reduce((a, c) => a + Number(c.quantity || 0), 0),
      reserved: list.reduce((a, c) => a + Number(c.reserved_quantity || 0), 0),
    };
  }, [contents]);

  if (isLoading) return <LoadingState />;
  if (!lpn) {
    return (
      <EmptyState
        icon={PackageOpen}
        title="License plate not found"
        description="It may have been consumed by a merge, or you do not have access."
        action={<Button onClick={() => nav("/warehouse-app/plates")}>Back to board</Button>}
      />
    );
  }

  // Stock cannot be restructured once the unit has left the building or
  // been closed out; the lifecycle rail below is governed by the FSM.
  const locked = lpn.status === "shipped" || lpn.status === "voided"
    || lpn.status === "retired" || lpn.status === "consumed";
  const sealed = !!lpn.sealed_at;
  // A plate with no bin has no source of stock: `wms_lpn_load` rejects it.
  const unlocated = !lpn.current_location_id;
  // Lines the current dialog may act on: loose bin stock to load, plate
  // contents to unload. Both carry the quantity ceiling the RPC enforces.
  const sourceLines = (dialog === "unload" ? contents : binStock) ?? [];
  const lineKey = (r: { product_id: string; lot_number?: string | null }) =>
    `${r.product_id}|${r.lot_number ?? ""}`;
  const selected = sourceLines.find((r) => lineKey(r) === line.productId);
  const available = selected
    ? Number(selected.quantity || 0) - Number(selected.reserved_quantity || 0)
    : 0;
  // The operator picks the unit they physically handled; the SERVER converts
  // it through `wms_to_base_qty`. `toBaseUnits` here is preview text only.
  const unitOptions = unitOptionsFor(qtyFmt.packsFor(selected?.product_id), qtyFmt.baseLabelFor(selected?.product_id));
  const unit = optionByKey(unitOptions, line.unitKey);
  const previewBase = toBaseUnits(Number(line.quantity), unit);

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="font-mono">{lpn.code}</span>
            <StatusBadge tone={STATUS_TONE[lpn.status] ?? "neutral"}>{lpn.status}</StatusBadge>
            {sealed && <Badge variant="secondary">sealed</Badge>}
          </span>
        }
        description={
          <span className="capitalize">
            {lpn.lpn_type} · {lpn.warehouse_name ?? "—"} ·{" "}
            {lpn.location_path ?? (lpn.location_code
              ? `${lpn.location_code} ${lpn.location_name ?? ""}`
              : "Unlocated")}
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to="/warehouse-app/plates"><ArrowLeft className="mr-2 h-4 w-4" /> Board</Link>
            </Button>
            <Button variant="outline" onClick={() => setLabelOpen(true)}>
              <Printer className="mr-2 h-4 w-4" /> Label
            </Button>
            <Button onClick={() => setDialog("move")} disabled={locked}>
              <MoveRight className="mr-2 h-4 w-4" /> Move
            </Button>
            <Button
              variant="outline"
              onClick={() => setDialog("load")}
              disabled={locked || sealed || unlocated}
              title={unlocated ? "Move the plate into a bin before loading stock" : undefined}
            >
              <Download className="mr-2 h-4 w-4" /> Load
            </Button>
            <Button
              variant="outline"
              onClick={() => setDialog("unload")}
              disabled={locked || sealed || unlocated || !contents?.length}
            >
              <Upload className="mr-2 h-4 w-4" /> Unload
            </Button>
            <Button variant="outline" onClick={() => setDialog("split")} disabled={locked || sealed}>
              <Split className="mr-2 h-4 w-4" /> Split
            </Button>
            {lpn.parent_lpn_id ? (
              <Button variant="outline" onClick={() => action.run({ kind: "unnest" })} disabled={locked}>
                <Unlink className="mr-2 h-4 w-4" /> Detach
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setDialog("nest")} disabled={locked}>
                <Link2 className="mr-2 h-4 w-4" /> Nest
              </Button>
            )}
            <LpnLifecycleRail plate={lpn} locations={locations ?? []} />
          </div>
        }
      />

      <PageBody>
        <div className="min-w-0 grid gap-3 @xl/page:grid-cols-2 @4xl/page:grid-cols-4">
          <Metric label="SKUs" value={totals.skus} />
          <Metric
            label="Stock on plate"
            value={
              (contents ?? []).length === 1
                ? qtyFmt.format(contents![0]!.product_id, contents![0]!.quantity)
                : (<AggregateQty qty={totals.units} />) as unknown as string
            }
            hint={`${totals.reserved} reserved`}
          />
          <Metric label="Nested plates" value={Number(lpn.child_count ?? 0)} />
          <Metric
            label="Bin"
            value={lpn.location_code ?? "—"}
            hint={lpn.location_path ?? lpn.location_name ?? "Unlocated"}
          />
        </div>

        <Section title="Contents" description="Stock physically carried by this handling unit.">
          {!contents?.length ? (
            <EmptyState
              icon={PackageOpen}
              title="Empty plate"
              description={
                unlocated
                  ? "This plate is not in a bin yet. Move it to a bin, then load stock from that bin."
                  : "Load stock from this plate's bin to start building the handling unit."
              }
              action={
                unlocated ? (
                  <Button onClick={() => setDialog("move")} disabled={locked}>Move to a bin</Button>
                ) : (
                  <Button onClick={() => setDialog("load")} disabled={locked || sealed}>Load stock</Button>
                )
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Lot</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Reserved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contents.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.products?.name ?? c.product_id}</TableCell>
                    <TableCell className="font-mono text-sm">{c.products?.sku ?? "—"}</TableCell>
                    <TableCell className="font-mono text-sm">{c.lot_number ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <WarehouseQty fmt={qtyFmt} productId={c.product_id} baseQty={c.quantity} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <WarehouseQty fmt={qtyFmt} productId={c.product_id} baseQty={c.reserved_quantity ?? 0} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>

        {!!children?.length && (
          <Section title="Nested plates" description="Child handling units that travel with this plate.">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plate</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">SKUs</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {children.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link to={`/warehouse-app/plates/${c.id}`} className="font-mono hover:underline">
                        {c.code}
                      </Link>
                    </TableCell>
                    <TableCell className="capitalize">{c.lpn_type}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(c.sku_count ?? 0)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <AggregateQty qty={c.total_quantity ?? 0} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        )}

        <Section title="Handling ledger" description="Every load, move, split, merge and status change on this plate.">
          {!events?.length ? (
            <p className="text-sm text-muted-foreground">No plate events yet.</p>
          ) : (
            <ol className="space-y-2">
              {events.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-4 border-b pb-2 last:border-0">
                  <div>
                    <p className="text-sm font-medium capitalize">{e.event_type.replace(/_/g, " ")}</p>
                    <p className="text-xs text-muted-foreground">
                      {e.from_status || e.to_status
                        ? `${e.from_status ?? "—"} → ${e.to_status ?? "—"}`
                        : null}
                      {e.quantity_delta ? " · " : ""}
                      {e.quantity_delta ? <AggregateQty qty={Math.abs(Number(e.quantity_delta))} /> : null}
                      {e.quantity_delta ? (Number(e.quantity_delta) < 0 ? " removed" : " added") : ""}
                    </p>
                  </div>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(e.created_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <ActivitySection aggregateId={lpn.id} />
      </PageBody>

      <LpnLabelDialog
        open={labelOpen}
        onOpenChange={setLabelOpen}
        orgId={currentOrg?.id}
        plates={[lpn]}
      />

      {/* Move */}
      <Dialog open={dialog === "move"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Move plate {lpn.code}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <ScanLine className="h-4 w-4" /> Scan the destination bin, or pick it below.
            </p>
            <div className="space-y-2">
              <Label>Destination bin</Label>
              <Select value={moveDest} onValueChange={setMoveDest}>
                <SelectTrigger><SelectValue placeholder="Choose bin" /></SelectTrigger>
                <SelectContent>
                  {(locations ?? []).map((l) => (
                    <SelectItem key={l.id} value={l.id}>{l.code} · {l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Reason / note</Label>
              <Textarea value={moveNote} onChange={(e) => setMoveNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              disabled={!moveDest || action.isPending}
              onClick={() =>
                action.run(
                  { kind: "move", toLocationId: moveDest, expectedVersion: lpn.row_version, reason: moveNote || null },
                  { onSuccess: () => { setDialog(null); setMoveDest(""); setMoveNote(""); } },
                )
              }
            >
              Move plate & stock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Load / Unload */}
      <Dialog open={dialog === "load" || dialog === "unload"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog === "load" ? "Load stock onto" : "Unload stock from"} {lpn.code}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>
                {dialog === "load"
                  ? `Available in ${lpn.location_code ?? "this bin"}`
                  : "On this plate"}
              </Label>
              <Select
                value={line.productId}
                onValueChange={(v) => {
                  const row = sourceLines.find((r) => lineKey(r) === v);
                  setLine((l) => ({
                    ...l,
                    productId: v,
                    lot: row?.lot_number ?? "",
                    quantity: l.quantity || "1",
                  }));
                }}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      sourceLines.length
                        ? "Pick a stock line"
                        : dialog === "load"
                          ? "No unassigned stock in this bin"
                          : "This plate is empty"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {sourceLines.map((r) => (
                    <SelectItem key={lineKey(r)} value={lineKey(r)}>
                      {r.products?.name ?? "Product"}
                      {r.lot_number ? ` · lot ${r.lot_number}` : ""} ·{" "}
                      {Number(r.quantity || 0) - Number(r.reserved_quantity || 0)} available
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {dialog === "load" && !sourceLines.length && (
                <p className="text-xs text-muted-foreground">
                  A plate can only pick up stock that is already loose in its own bin
                  ({lpn.location_path ?? lpn.location_code ?? "unlocated"}). Put stock away
                  into that bin first.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Quantity</Label>
              <Input
                type="number" min="0" max={available || undefined} step="any"
                value={line.quantity}
                onChange={(e) => setLine((l) => ({ ...l, quantity: e.target.value }))}
              />
              {!!selected && (
                <p className="text-xs text-muted-foreground">Max {available}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              disabled={
                !selected || Number(line.quantity) <= 0
                || Number(line.quantity) > available || action.isPending
              }
              onClick={() =>
                selected && action.run(
                  dialog === "load"
                    ? { kind: "load", productId: selected.product_id, quantity: Number(line.quantity), lotNumber: selected.lot_number || null }
                    : { kind: "unload", productId: selected.product_id, quantity: Number(line.quantity), lotNumber: selected.lot_number || null },
                  { onSuccess: () => { setDialog(null); setLine({ productId: "", quantity: "1", lot: "", serial: "" }); } },
                )
              }
            >
              {dialog === "load" ? "Load" : "Unload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Split */}
      <Dialog open={dialog === "split"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Split {lpn.code}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Quantities entered below move onto a brand-new plate at the same bin.
          </p>
          <div className="max-h-[320px] space-y-3 overflow-y-auto">
            {(contents ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{c.products?.name ?? c.product_id}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.lot_number ? `Lot ${c.lot_number} · ` : ""}on plate: {Number(c.quantity)}
                  </p>
                </div>
                <Input
                  className="w-28"
                  type="number" min="0" step="any"
                  value={splitLines[c.id] ?? ""}
                  onChange={(e) => setSplitLines((s) => ({ ...s, [c.id]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              disabled={action.isPending}
              onClick={() => {
                const lines = (contents ?? [])
                  .map((c) => ({
                    product_id: c.product_id,
                    quantity: Number(splitLines[c.id] ?? 0),
                    lot_number: c.lot_number,
                  }))
                  .filter((l) => l.quantity > 0);
                if (!lines.length) return toast.error("Enter at least one quantity");
                action.run({ kind: "split", lines }, { onSuccess: () => { setDialog(null); setSplitLines({}); } });
              }}
            >
              Split to new plate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nest */}
      <Dialog open={dialog === "nest"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nest {lpn.code} under a parent</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <Label>Parent plate code</Label>
            <ScanTextField
              placeholder="Scan or type the parent plate code"
              cameraLabel="Scan the parent plate"
              priority={40}
              value={parentCode}
              onChange={setParentCode}
            />

          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              disabled={!parentCode.trim() || action.isPending}
              onClick={async () => {
                if (!currentBusiness?.id) return;
                const parent = await resolveLpnByCode(currentBusiness.id, parentCode);
                if (!parent) return toast.error(`No plate ${parentCode}`);
                action.run({ kind: "nest", parentId: parent.id }, {
                  onSuccess: () => { setDialog(null); setParentCode(""); },
                });
              }}
            >
              Nest plate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
