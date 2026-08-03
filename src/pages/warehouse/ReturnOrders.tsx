/**
 * ReturnOrders — the returns operations console (Returns audit, Phase 4).
 *
 * The page is a *tower*: lanes derived from header state plus line facts show
 * where returns are stuck, and selecting a return opens the split-pane
 * workspace where capture, inspection, disposition, posting and closure all
 * happen against `wms_return_lines` through server-guarded RPCs. Header state
 * is never written directly from the client.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState, LoadingState, PageBody, PageHeader, Section, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ResizableHandle, ResizablePanel, ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Plus, Undo2 } from "lucide-react";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";

import { useCreateReturnOrder, useReturnOrders } from "@/features/warehouse/returns/useReturnOrders";
import { useReturnLinesForOrders } from "@/features/warehouse/returns/useReturnLines";
import { ReturnsLaneBoard } from "@/features/warehouse/returns/ReturnsLaneBoard";
import { ReturnWorkspace } from "@/features/warehouse/returns/ReturnWorkspace";
import {
  RETURN_LANE_LABEL,
  RETURN_OPEN_STATES,
  RETURN_STATE_TONE,
  ageHours,
  isLaneBreached,
  returnLaneClock,

  returnLane,
  type ReturnKind,
  type ReturnLane,
  type ReturnOrder,
  type ReturnState,
} from "@/features/warehouse/returns/returnsModel";

function newCode(): string {
  const d = new Date();
  const stamp = `${d.getFullYear().toString().slice(-2)}${(d.getMonth() + 1)
    .toString()
    .padStart(2, "0")}${d.getDate().toString().padStart(2, "0")}`;
  return `RMA-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function label(value: string | null | undefined): string {
  return value ? value.replace(/_/g, " ") : "—";
}

export default function ReturnOrders() {
  const { warehouses } = useWarehouses();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { user } = useAuth();

  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<string>("open_all");
  const [lane, setLane] = useState<ReturnLane | "all">("all");
  const [selected, setSelected] = useState<ReturnOrder | null>(null);

  const states: ReturnState[] | undefined =
    stateFilter === "open_all"
      ? RETURN_OPEN_STATES
      : stateFilter === "all"
        ? undefined
        : [stateFilter as ReturnState];

  const { data: orders, isLoading } = useReturnOrders({
    businessId: currentBusiness?.id,
    warehouseId: warehouseFilter === "all" ? null : warehouseFilter,
    states,
  });

  const orderIds = useMemo(() => (orders ?? []).map((o) => o.id), [orders]);
  const { data: linesByOrder } = useReturnLinesForOrders(orderIds);
  const lineMap = linesByOrder ?? new Map();

  const visible = useMemo(() => {
    const rows = orders ?? [];
    if (lane === "all") return rows;
    return rows.filter((o) => returnLane(o, lineMap.get(o.id) ?? []) === lane);
  }, [orders, lane, lineMap]);

  // Keep the open workspace bound to fresh header data (row_version moves).
  const activeOrder = useMemo(
    () => (selected ? (orders ?? []).find((o) => o.id === selected.id) ?? selected : null),
    [selected, orders],
  );

  const create = useCreateReturnOrder();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    code: newCode(),
    rma_reference: "",
    warehouse_id: "",
    return_kind: "customer" as ReturnKind,
    source_doc_type: "",
    source_doc_id: "",
    tracking_reference: "",
    notes: "",
  });

  const submitCreate = () => {
    if (!currentBusiness?.id || !currentOrg?.id) {
      toast.error("No active organization");
      return;
    }
    if (!form.warehouse_id) {
      toast.error("Choose a warehouse");
      return;
    }
    create.mutate(
      {
        organizationId: currentOrg.id,
        businessId: currentBusiness.id,
        warehouseId: form.warehouse_id,
        code: form.code.trim(),
        returnKind: form.return_kind,
        rmaReference: form.rma_reference || null,
        sourceDocType: form.source_doc_type || null,
        sourceDocId: form.source_doc_id || null,
        trackingReference: form.tracking_reference || null,
        notes: form.notes || null,
        createdBy: user?.id ?? null,
      },
      {
        onSuccess: () => {
          toast.success("Return order created");
          setCreateOpen(false);
          setForm((f) => ({ ...f, code: newCode(), rma_reference: "", source_doc_id: "", notes: "" }));
        },
        onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Create failed"),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Returns console"
        description="RMA execution tower. Capture returned units, inspect condition, disposition stock and post inventory effects with a single audited path."
        actions={
          <Button
            onClick={() => {
              setForm((f) => ({ ...f, code: newCode() }));
              setCreateOpen(true);
            }}
          >
            <Plus className="mr-2 h-4 w-4" /> New return
          </Button>
        }
      />
      <PageBody>
        <Section>
          <ResizablePanelGroup
            direction="horizontal"
            className="min-h-[70vh] items-stretch rounded-lg border"
          >
            <ResizablePanel defaultSize={activeOrder ? 55 : 100} minSize={30}>
              <div className="h-full space-y-4 overflow-y-auto p-4">
                <ReturnsLaneBoard
                  orders={orders ?? []}
                  linesByOrder={lineMap}
                  activeLane={lane}
                  onSelectLane={setLane}
                />

                <Card>
                  <CardContent className="space-y-4 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={stateFilter} onValueChange={setStateFilter}>
                        <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="open_all">Open (default)</SelectItem>
                          <SelectItem value="draft">Draft</SelectItem>
                          <SelectItem value="authorized">Authorized</SelectItem>
                          <SelectItem value="in_transit">In transit</SelectItem>
                          <SelectItem value="received">Received</SelectItem>
                          <SelectItem value="inspecting">Inspecting</SelectItem>
                          <SelectItem value="disposed">Disposed</SelectItem>
                          <SelectItem value="closed">Closed</SelectItem>
                          <SelectItem value="cancelled">Cancelled</SelectItem>
                          <SelectItem value="all">All</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                        <SelectTrigger className="w-[180px]">
                          <SelectValue placeholder="Warehouse" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All warehouses</SelectItem>
                          {warehouses.map((w) => (
                            <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {lane !== "all" && (
                        <Button variant="ghost" size="sm" onClick={() => setLane("all")}>
                          Clear lane: {RETURN_LANE_LABEL[lane]}
                        </Button>
                      )}
                    </div>

                    {isLoading ? (
                      <LoadingState />
                    ) : visible.length === 0 ? (
                      <EmptyState
                        icon={Undo2}
                        title="No returns in this view"
                        description="Create a return when an RMA is issued or a customer parcel arrives at the dock."
                      />
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Code</TableHead>
                            <TableHead>Kind</TableHead>
                            <TableHead>State</TableHead>
                            <TableHead>Lane</TableHead>
                            <TableHead className="text-right">Lines</TableHead>
                            <TableHead className="text-right">Age</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visible.map((o) => {
                            const rows = lineMap.get(o.id) ?? [];
                            const age = ageHours(o.received_at ?? o.created_at);
                            return (
                              <TableRow
                                key={o.id}
                                className={`cursor-pointer ${
                                  activeOrder?.id === o.id ? "bg-muted/60" : ""
                                }`}
                                onClick={() => setSelected(o)}
                              >
                                <TableCell className="font-mono">{o.code}</TableCell>
                                <TableCell className="text-sm">{label(o.return_kind)}</TableCell>
                                <TableCell>
                                  <StatusBadge tone={RETURN_STATE_TONE[o.state]}>
                                    {label(o.state)}
                                  </StatusBadge>
                                </TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                  {RETURN_LANE_LABEL[returnLane(o, rows)]}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{rows.length}</TableCell>
                                <TableCell className="text-right text-sm text-muted-foreground tabular-nums">
                                  {age == null ? "—" : `${Math.round(age)}h`}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              </div>
            </ResizablePanel>

            {activeOrder && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize={45} minSize={30}>
                  <ReturnWorkspace order={activeOrder} onClose={() => setSelected(null)} />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </Section>
      </PageBody>


      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New return order</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Code</Label>
                <Input
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  className="font-mono"
                />
              </div>
              <div>
                <Label>RMA reference</Label>
                <Input
                  value={form.rma_reference}
                  onChange={(e) => setForm({ ...form, rma_reference: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Return kind</Label>
                <Select
                  value={form.return_kind}
                  onValueChange={(v) => setForm({ ...form, return_kind: v as ReturnKind })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="customer">Customer</SelectItem>
                    <SelectItem value="vendor">Vendor</SelectItem>
                    <SelectItem value="internal">Internal</SelectItem>
                    <SelectItem value="transfer">Transfer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Warehouse</Label>
                <Select
                  value={form.warehouse_id}
                  onValueChange={(v) => setForm({ ...form, warehouse_id: v })}
                >
                  <SelectTrigger><SelectValue placeholder="Choose warehouse" /></SelectTrigger>
                  <SelectContent>
                    {warehouses.map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Source doc type</Label>
                <Input
                  value={form.source_doc_type}
                  onChange={(e) => setForm({ ...form, source_doc_type: e.target.value })}
                  placeholder="sales_order / bill"
                />
              </div>
              <div>
                <Label>Source doc id</Label>
                <Input
                  value={form.source_doc_id}
                  onChange={(e) => setForm({ ...form, source_doc_id: e.target.value })}
                  className="font-mono"
                />
              </div>
            </div>
            <div>
              <Label>Tracking reference</Label>
              <Input
                value={form.tracking_reference}
                onChange={(e) => setForm({ ...form, tracking_reference: e.target.value })}
              />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={submitCreate} disabled={create.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
