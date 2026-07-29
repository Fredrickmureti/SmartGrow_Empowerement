/**
 * ReturnOrders — RMA execution surface (ADR 0101).
 *
 * States: draft → authorized → in_transit → received → inspecting → disposed → closed (+ cancelled).
 * All transitions go through `wms_transition_return` — FSM-guarded,
 * row_version optimistic, emits `warehouse.return.*` to outbox.
 * Disposition outcome is carried in the outbox payload extra.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader, PageBody, Section, LoadingState, EmptyState, StatusBadge,
} from "@/design-system";
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
import { useWarehouses } from "@/hooks/useWarehouses";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { Undo2, Plus, Play, Check, AlertTriangle, Truck } from "lucide-react";

type ReturnState = "draft" | "authorized" | "in_transit" | "received" | "inspecting" | "disposed" | "closed" | "cancelled";
type Disposition = "return_to_stock" | "quarantine" | "scrap" | "refurbish";

interface ReturnRow {
  id: string;
  code: string;
  rma_reference: string | null;
  warehouse_id: string;
  state: ReturnState;
  source_doc_type: string | null;
  source_doc_id: string | null;
  customer_id: string | null;
  vendor_id: string | null;
  expected_at: string | null;
  received_at: string | null;
  closed_at: string | null;
  notes: string | null;
  row_version: number;
  created_at: string;
}

const TONE: Record<ReturnState, "info" | "warning" | "success" | "neutral" | "danger"> = {
  draft: "neutral",
  authorized: "info",
  in_transit: "info",
  received: "warning",
  inspecting: "warning",
  disposed: "success",
  closed: "success",
  cancelled: "neutral",
};

const OPEN_STATES: ReturnState[] = ["draft", "authorized", "in_transit", "received", "inspecting", "disposed"];

function newCode(): string {
  const d = new Date();
  const stamp = `${d.getFullYear().toString().slice(-2)}${(d.getMonth() + 1).toString().padStart(2, "0")}${d.getDate().toString().padStart(2, "0")}`;
  return `RMA-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export default function ReturnOrders() {
  const qc = useQueryClient();
  const { warehouses } = useWarehouses();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { user } = useAuth();

  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<string>("open_all");

  const { data: rows, isLoading } = useQuery({
    queryKey: ["wms-return-orders", currentBusiness?.id, warehouseFilter, stateFilter],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_return_orders" as any)
        .select("id, code, rma_reference, warehouse_id, state, source_doc_type, source_doc_id, customer_id, vendor_id, expected_at, received_at, closed_at, notes, row_version, created_at")
        .eq("business_id", currentBusiness!.id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      if (stateFilter === "open_all") q = q.in("state", OPEN_STATES);
      else if (stateFilter !== "all") q = q.eq("state", stateFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ReturnRow[];
    },
  });

  const transition = useMutation({
    mutationFn: async (input: { id: string; to: ReturnState; rowVersion: number; reason?: string; payload?: Record<string, unknown> }) => {
      const { error } = await supabase.rpc("wms_transition_return" as any, {
        p_return_id: input.id,
        p_to_state: input.to,
        p_row_version: input.rowVersion,
        p_reason: input.reason ?? null,
        p_payload: input.payload ?? {},
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-return-orders"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Transition rejected"),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    code: newCode(),
    rma_reference: "",
    warehouse_id: "",
    source_doc_type: "",
    source_doc_id: "",
    notes: "",
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id || !currentOrg?.id) throw new Error("No active organization");
      if (!form.warehouse_id) throw new Error("Choose a warehouse");
      const wh = warehouses.find((w) => w.id === form.warehouse_id);
      const { error } = await supabase.from("wms_return_orders" as any).insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: wh?.branch_id ?? null,
        warehouse_id: form.warehouse_id,
        code: form.code.trim(),
        rma_reference: form.rma_reference || null,
        source_doc_type: form.source_doc_type || null,
        source_doc_id: form.source_doc_id || null,
        state: "draft",
        notes: form.notes || null,
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Return order created");
      setCreateOpen(false);
      setForm({ code: newCode(), rma_reference: "", warehouse_id: "", source_doc_type: "", source_doc_id: "", notes: "" });
      qc.invalidateQueries({ queryKey: ["wms-return-orders"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Create failed"),
  });

  const [dispositionFor, setDispositionFor] = useState<ReturnRow | null>(null);
  const [disposition, setDisposition] = useState<Disposition>("return_to_stock");
  const applyDisposition = () => {
    if (!dispositionFor) return;
    transition.mutate(
      {
        id: dispositionFor.id,
        to: "disposed",
        rowVersion: dispositionFor.row_version,
        reason: `Dispositioned: ${disposition}`,
        payload: { disposition },
      },
      { onSuccess: () => { setDispositionFor(null); toast.success("Disposition recorded"); } },
    );
  };

  const emptyLabel = useMemo(
    () => (stateFilter === "open_all" ? "No open return orders" : "No returns match these filters"),
    [stateFilter],
  );

  const nextActions = (r: ReturnRow) => {
    const t = (to: ReturnState, reason?: string) =>
      transition.mutate({ id: r.id, to, rowVersion: r.row_version, reason });
    switch (r.state) {
      case "draft":      return [{ label: "Authorize", icon: Check, run: () => t("authorized") }];
      case "authorized": return [
        { label: "In transit", icon: Truck, run: () => t("in_transit") },
        { label: "Mark received", icon: Play, run: () => t("received") },
      ];
      case "in_transit": return [{ label: "Mark received", icon: Play, run: () => t("received") }];
      case "received":   return [{ label: "Inspect", icon: AlertTriangle, run: () => t("inspecting") }];
      case "inspecting": return [{ label: "Disposition", icon: Check, run: () => setDispositionFor(r) }];
      case "disposed":   return [{ label: "Close", icon: Check, run: () => t("closed") }];
      default: return [];
    }
  };

  return (
    <>
      <PageHeader
        title="Return orders"
        description="RMA execution surface. Authorize, receive, inspect, and disposition returns with a uniform event trail."
        actions={
          <Button onClick={() => { setForm((f) => ({ ...f, code: newCode() })); setCreateOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" /> New return
          </Button>
        }
      />
      <PageBody>
        <Section>
          <Card>
            <CardContent className="p-4 space-y-4">
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
                  <SelectTrigger className="w-[180px]"><SelectValue placeholder="Warehouse" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All warehouses</SelectItem>
                    {warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {isLoading ? (
                <LoadingState />
              ) : (rows ?? []).length === 0 ? (
                <EmptyState icon={Undo2} title={emptyLabel} description="Create a return when an RMA is issued or a customer parcel arrives." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>RMA ref</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Expected</TableHead>
                      <TableHead>Received</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(rows ?? []).map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono">{r.code}</TableCell>
                        <TableCell className="text-sm">{r.rma_reference ?? "—"}</TableCell>
                        <TableCell><StatusBadge tone={TONE[r.state]}>{r.state.replace("_", " ")}</StatusBadge></TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.expected_at ? new Date(r.expected_at).toLocaleString() : "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.received_at ? new Date(r.received_at).toLocaleString() : "—"}</TableCell>
                        <TableCell className="text-right space-x-1">
                          {nextActions(r).map((a, i) => (
                            <Button key={i} size="sm" variant={a.label === "Close" || a.label === "Disposition" ? "default" : "outline"} onClick={a.run}>
                              <a.icon className="h-3.5 w-3.5 mr-1" />{a.label}
                            </Button>
                          ))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </Section>
      </PageBody>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New return order</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Code</Label>
                <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="font-mono" />
              </div>
              <div>
                <Label>RMA reference</Label>
                <Input value={form.rma_reference} onChange={(e) => setForm({ ...form, rma_reference: e.target.value })} />
              </div>
            </div>
            <div>
              <Label>Warehouse</Label>
              <Select value={form.warehouse_id} onValueChange={(v) => setForm({ ...form, warehouse_id: v })}>
                <SelectTrigger><SelectValue placeholder="Choose warehouse" /></SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Source doc type</Label>
                <Input value={form.source_doc_type} onChange={(e) => setForm({ ...form, source_doc_type: e.target.value })} placeholder="sales_order / bill" />
              </div>
              <div>
                <Label>Source doc id</Label>
                <Input value={form.source_doc_id} onChange={(e) => setForm({ ...form, source_doc_id: e.target.value })} className="font-mono" />
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dispositionFor} onOpenChange={(o) => !o && setDispositionFor(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Disposition return</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Label>Outcome</Label>
            <Select value={disposition} onValueChange={(v) => setDisposition(v as Disposition)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="return_to_stock">Return to stock</SelectItem>
                <SelectItem value="quarantine">Quarantine</SelectItem>
                <SelectItem value="scrap">Scrap</SelectItem>
                <SelectItem value="refurbish">Refurbish</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDispositionFor(null)}>Cancel</Button>
            <Button onClick={applyDisposition} disabled={transition.isPending}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
