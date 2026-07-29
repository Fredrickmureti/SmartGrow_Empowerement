/**
 * ReceivingSessions — WMS receiving unit of work (ADR 0101).
 *
 * States: open → unloading → captured → posted → closed (+ discrepant, cancelled).
 * All transitions go through `wms_transition_receiving` — FSM-guarded,
 * row_version optimistic, emits `warehouse.receiving.*` to outbox.
 */
import { useMemo, useState, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useWmsScanIntent, type WmsScanPayload } from "@/features/warehouse/scanning/wmsScanIntent";
import { scanFeedbackBus } from "@/services/pos/scanFeedbackBus";
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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { useWarehouses } from "@/hooks/useWarehouses";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
import { PackageOpen, Plus, Play, Check, AlertTriangle, PackageCheck } from "lucide-react";

type RcvState = "open" | "unloading" | "captured" | "discrepant" | "posted" | "closed" | "cancelled";

interface SessionRow {
  id: string;
  code: string;
  warehouse_id: string;
  state: RcvState;
  started_at: string | null;
  closed_at: string | null;
  source_doc_type: string | null;
  source_doc_id: string | null;
  notes: string | null;
  row_version: number;
  created_at: string;
}

const TONE: Record<RcvState, "info" | "warning" | "success" | "neutral" | "danger"> = {
  open: "neutral",
  unloading: "info",
  captured: "warning",
  discrepant: "danger",
  posted: "success",
  closed: "success",
  cancelled: "neutral",
};

const OPEN_STATES: RcvState[] = ["open", "unloading", "captured", "discrepant"];

function newCode(): string {
  const d = new Date();
  const stamp = `${d.getFullYear().toString().slice(-2)}${(d.getMonth() + 1).toString().padStart(2, "0")}${d.getDate().toString().padStart(2, "0")}`;
  return `RCV-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export default function ReceivingSessions() {
  const qc = useQueryClient();
  const { warehouses } = useWarehouses();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { user } = useAuth();

  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<string>("open_all");

  const { data: rows, isLoading } = useQuery({
    queryKey: ["wms-receiving-sessions", currentBusiness?.id, warehouseFilter, stateFilter],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_receiving_sessions" as any)
        .select("id, code, warehouse_id, state, started_at, closed_at, source_doc_type, source_doc_id, notes, row_version, created_at")
        .eq("business_id", currentBusiness!.id)
        .order("created_at", { ascending: false })
        .limit(500);
      if (warehouseFilter !== "all") q = q.eq("warehouse_id", warehouseFilter);
      if (stateFilter === "open_all") q = q.in("state", OPEN_STATES);
      else if (stateFilter !== "all") q = q.eq("state", stateFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as SessionRow[];
    },
  });

  const transition = useMutation({
    mutationFn: async (input: { id: string; to: RcvState; rowVersion: number; reason?: string }) => {
      const { error } = await supabase.rpc("wms_transition_receiving" as any, {
        p_session_id: input.id,
        p_to_state: input.to,
        p_row_version: input.rowVersion,
        p_reason: input.reason ?? null,
        p_payload: {},
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-receiving-sessions"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Transition rejected"),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    code: newCode(),
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
      const { error } = await supabase.from("wms_receiving_sessions" as any).insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: wh?.branch_id ?? null,
        warehouse_id: form.warehouse_id,
        code: form.code.trim(),
        source_doc_type: form.source_doc_type || null,
        source_doc_id: form.source_doc_id || null,
        state: "open",
        notes: form.notes || null,
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Receiving session created");
      setCreateOpen(false);
      setForm({ code: newCode(), warehouse_id: "", source_doc_type: "", source_doc_id: "", notes: "" });
      qc.invalidateQueries({ queryKey: ["wms-receiving-sessions"] });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Create failed"),
  });

  const emptyLabel = useMemo(
    () => (stateFilter === "open_all" ? "No open receiving sessions" : "No sessions match these filters"),
    [stateFilter],
  );

  // Phase 2.1 — WMS scan intents.
  // The topmost `open` session receives `receiving.lpn` scans (start unloading);
  // the topmost `unloading` session receives `receiving.item` scans (mark captured).
  // Ambiguous state (0 or >1 candidates) reports the scan as unexpected so the
  // operator gets audio+haptic feedback instead of a silent no-op.
  const openSessions = useMemo(
    () => (rows ?? []).filter((r) => r.state === "open"),
    [rows],
  );
  const unloadingSessions = useMemo(
    () => (rows ?? []).filter((r) => r.state === "unloading"),
    [rows],
  );

  const handleLpnScan = useCallback(
    (p: WmsScanPayload) => {
      if (openSessions.length !== 1) {
        scanFeedbackBus.emit({
          kind: "error",
          raw: p.raw,
          source: "field",
          workflow: "receive",
          detail:
            openSessions.length === 0
              ? "No open receiving session — create one first"
              : "Multiple open sessions — pick one before scanning",
        });
        return;
      }
      const target = openSessions[0];
      transition.mutate(
        { id: target.id, to: "unloading", rowVersion: target.row_version, reason: `LPN ${p.resolveCode}` },
        {
          onSuccess: () =>
            toast.success(`Unloading ${target.code}`, { description: `LPN ${p.resolveCode}` }),
        },
      );
    },
    [openSessions, transition],
  );

  const handleItemScan = useCallback(
    (p: WmsScanPayload) => {
      if (unloadingSessions.length !== 1) {
        scanFeedbackBus.emit({
          kind: "error",
          raw: p.raw,
          source: "field",
          workflow: "receive",
          detail:
            unloadingSessions.length === 0
              ? "No session unloading — scan an LPN to start"
              : "Multiple sessions unloading — pick one before scanning items",
        });
        return;
      }
      const target = unloadingSessions[0];
      transition.mutate(
        { id: target.id, to: "captured", rowVersion: target.row_version, reason: `Item ${p.resolveCode}` },
        {
          onSuccess: () =>
            toast.success(`Captured on ${target.code}`, {
              description: p.isGs1
                ? `GTIN ${p.gs1.gtin ?? p.resolveCode}${p.gs1.lot ? ` · lot ${p.gs1.lot}` : ""}${p.gs1.expiry ? ` · exp ${p.gs1.expiry}` : ""}`
                : p.resolveCode,
            }),
        },
      );
    },
    [unloadingSessions, transition],
  );

  useWmsScanIntent({
    intent: "receiving.lpn",
    onScan: handleLpnScan,
    label: "receiving-sessions.lpn",
  });
  useWmsScanIntent({
    intent: "receiving.item",
    onScan: handleItemScan,
    label: "receiving-sessions.item",
  });

  const nextActions = (r: SessionRow) => {
    const t = (to: RcvState, reason?: string) =>
      transition.mutate({ id: r.id, to, rowVersion: r.row_version, reason });
    switch (r.state) {
      case "open":       return [{ label: "Start unloading", icon: Play, run: () => t("unloading") }];
      case "unloading":  return [
        { label: "Mark captured", icon: PackageCheck, run: () => t("captured") },
        { label: "Discrepant", icon: AlertTriangle, run: () => t("discrepant", "Marked discrepant during unload") },
      ];
      case "captured":   return [
        { label: "Post to inventory", icon: Check, run: () => t("posted") },
        { label: "Discrepant", icon: AlertTriangle, run: () => t("discrepant") },
      ];
      case "discrepant": return [
        { label: "Post anyway", icon: Check, run: () => t("posted", "Posted with discrepancies") },
        { label: "Close", icon: Check, run: () => t("closed") },
      ];
      case "posted":     return [{ label: "Close", icon: Check, run: () => t("closed") }];
      default: return [];
    }
  };

  return (
    <>
      <PageHeader
        title="Receiving sessions"
        description="Supervised unload blocks. Group ASN/appointment work into a session so putaway fan-out and discrepancies can be traced."
        actions={
          <Button onClick={() => { setForm((f) => ({ ...f, code: newCode() })); setCreateOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" /> New session
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
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="unloading">Unloading</SelectItem>
                    <SelectItem value="captured">Captured</SelectItem>
                    <SelectItem value="discrepant">Discrepant</SelectItem>
                    <SelectItem value="posted">Posted</SelectItem>
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
                <EmptyState icon={PackageOpen} title={emptyLabel} description="Create a session when a truck arrives or an ASN is opened." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Closed</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(rows ?? []).map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono">{r.code}</TableCell>
                        <TableCell><StatusBadge tone={TONE[r.state]}>{r.state.replace("_", " ")}</StatusBadge></TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.source_doc_type ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.started_at ? new Date(r.started_at).toLocaleString() : "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.closed_at ? new Date(r.closed_at).toLocaleString() : "—"}</TableCell>
                        <TableCell className="text-right space-x-1">
                          {nextActions(r).map((a, i) => (
                            <Button key={i} size="sm" variant={a.label.startsWith("Post") || a.label === "Close" ? "default" : "outline"} onClick={a.run}>
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
          <DialogHeader><DialogTitle>New receiving session</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Code</Label>
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="font-mono" />
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
                <Label>Source doc type (optional)</Label>
                <Input value={form.source_doc_type} onChange={(e) => setForm({ ...form, source_doc_type: e.target.value })} placeholder="asn / po / goods_receipt" />
              </div>
              <div>
                <Label>Source doc id (optional)</Label>
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
    </>
  );
}
