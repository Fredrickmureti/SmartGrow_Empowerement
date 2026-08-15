/**
 * ReceivingSessions — WMS receiving unit of work (ADR 0101).
 *
 * States: open → unloading → captured → posted → closed (+ discrepant, cancelled).
 * All transitions go through `wms_transition_receiving` — FSM-guarded,
 * row_version optimistic, emits `warehouse.receiving.*` to outbox.
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useWmsScanIntent, type WmsScanPayload } from "@/features/warehouse/scanning/wmsScanIntent";
import { scanFeedbackBus } from "@/services/pos/scanFeedbackBus";
import { useWmsIdentityGate, describeLevel } from "@/features/warehouse/scanning/useWmsIdentityGate";
import {
  PageHeader, PageBody, Section, LoadingState, EmptyState, StatusBadge,
} from "@/design-system";
import { Button } from "@/components/ui/button";
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
import { PackageOpen, Plus, Play, Check, AlertTriangle, PackageCheck, LayoutGrid, Rows3 } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import ReceivingSessionBoard from "@/features/warehouse/receiving/ReceivingSessionBoard";
import { useReceivingTrailerVisits } from "@/features/warehouse/receiving/useReceivingTrailerVisits";
import { tryResolvePlateScan } from "@/features/warehouse/receiving/useReceivingLpn";
import { ActivityHistoryButton } from "@/features/warehouse/events/ActivitySection";
import ReceivingSessionWorkspace from "@/features/warehouse/receiving/ReceivingSessionWorkspace";
import { ScanGuidance } from "@/features/warehouse/scanning/ScanGuidance";
import {
  useReceivingProgress,
  useCaptureReceivingLine,
  useMaterializeExpectedLines,
} from "@/features/warehouse/receiving/useReceivingLines";

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
  appointment_id: string | null;
  dock_id: string | null;
  supervisor_id: string | null;
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
  const identityGate = useWmsIdentityGate(currentBusiness?.id);
  const { currentOrg } = useOrganization();
  const { user } = useAuth();

  const { data: progress } = useReceivingProgress(currentBusiness?.id);
  const captureLine = useCaptureReceivingLine();
  const materialize = useMaterializeExpectedLines();
  const [activeSession, setActiveSession] = useState<SessionRow | null>(null);

  // Phase 5b — the dock board is the default read: lanes per state, one card
  // per trailer. The table stays available for audit-style scanning.
  const [view, setView] = useState<"board" | "table">("board");

  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<string>("open_all");

  const { data: rows, isLoading } = useQuery({
    queryKey: ["wms-receiving-sessions", currentBusiness?.id, warehouseFilter, stateFilter],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_receiving_sessions" as any)
        .select("id, code, warehouse_id, state, started_at, closed_at, source_doc_type, source_doc_id, appointment_id, dock_id, supervisor_id, notes, row_version, created_at")
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

  // Typed source-document binding: sessions bind to a real PO or ASN row, so
  // expected quantities (and therefore variance) are computable.
  const { data: sourceDocs } = useQuery({
    queryKey: ["wms-receiving-source-docs", currentBusiness?.id, "purchase_order"],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("id, po_number, status")
        .eq("business_id", currentBusiness!.id)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as { id: string; po_number: string | null; status: string | null }[];
    },
  });

  // GRN convergence: an ASN (inbound shipment) is a first-class source document
  // — posting delegates to `receive_inbound_shipment` for it — so it must be
  // bindable at session creation, not only a purchase order.
  const { data: shipmentDocs } = useQuery({
    queryKey: ["wms-receiving-source-docs", currentBusiness?.id, "inbound_shipment"],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inbound_shipments")
        .select("id, shipment_number, status")
        .eq("business_id", currentBusiness!.id)
        .not("status", "in", "(received,cancelled)")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as { id: string; shipment_number: string | null; status: string | null }[];
    },
  });

  // Phase 1 — the truck must be visible. Sessions bind to a real inbound dock
  // appointment (which carries carrier, dock and window) instead of leaving
  // `appointment_id` / `dock_id` null, so an operator can answer "which trailer
  // am I on?" and dwell/dock metrics stay attributable.
  const { data: docks } = useQuery({
    queryKey: ["wms-receiving-docks", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("warehouse_docks")
        .select("id, code, name, warehouse_id")
        .eq("business_id", currentBusiness!.id)
        .limit(500);
      if (error) throw error;
      return (data ?? []) as { id: string; code: string; name: string | null; warehouse_id: string }[];
    },
  });

  const { data: appointments } = useQuery({
    queryKey: ["wms-receiving-appointments", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_dock_appointments")
        .select("id, dock_id, warehouse_id, reference, state, window_start, window_end, appointment_type")
        .eq("business_id", currentBusiness!.id)
        .eq("appointment_type", "inbound")
        .in("state", ["scheduled", "arrived", "in_progress"])
        .order("window_start", { ascending: true })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as {
        id: string; dock_id: string; warehouse_id: string; reference: string | null;
        state: string; window_start: string; window_end: string; appointment_type: string;
      }[];
    },
  });

  const dockLabel = useCallback(
    (id: string | null) => {
      if (!id) return null;
      const d = (docks ?? []).find((x) => x.id === id);
      return d ? (d.name ? `${d.code} — ${d.name}` : d.code) : id.slice(0, 8);
    },
    [docks],
  );

  // Supervisor of record — resolved once per board render, never per card.
  const supervisorIds = useMemo(
    () => Array.from(new Set((rows ?? []).map((r) => r.supervisor_id).filter(Boolean) as string[])),
    [rows],
  );
  const { data: supervisors } = useQuery({
    queryKey: ["wms-receiving-supervisors", supervisorIds],
    enabled: supervisorIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", supervisorIds);
      if (error) throw error;
      const map = new Map<string, string>();
      for (const p of (data ?? []) as { user_id: string; full_name: string | null; email: string | null }[]) {
        map.set(p.user_id, p.full_name || p.email || p.user_id.slice(0, 8));
      }
      return map;
    },
  });

  const supervisorLabel = useCallback(
    (id: string | null) => {
      if (!id) return "no supervisor";
      if (id === user?.id) return "you";
      return supervisors?.get(id) ?? "supervisor";
    },
    [supervisors, user?.id],
  );

  const appointmentFor = useCallback(
    (id: string | null) => {
      if (!id) return null;
      const a = (appointments ?? []).find((x) => x.id === id);
      return a
        ? { window_start: a.window_start, window_end: a.window_end, reference: a.reference, state: a.state }
        : null;
    },
    [appointments],
  );

  // Phase 1 remainder — the physical trailer behind the appointment: carrier,
  // trailer reference, driver, seals and dwell, read from the yard's
  // `wms_trailer_visits`. Receiving never writes it; the yard board owns it.
  const sessionAppointmentIds = useMemo(
    () => (rows ?? []).map((r) => r.appointment_id).filter(Boolean) as string[],
    [rows],
  );
  const trailerVisits = useReceivingTrailerVisits(currentBusiness?.id, sessionAppointmentIds);
  const trailerVisitFor = useCallback(
    (appointmentId: string | null) => (appointmentId ? (trailerVisits?.get(appointmentId) ?? null) : null),
    [trailerVisits],
  );


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
    // PostgREST errors are plain objects, not Error instances — reading only
    // `instanceof Error` swallowed the real reason and showed a generic toast.
    onError: (e: unknown) => {
      const msg =
        typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string"
          ? (e as { message: string }).message
          : null;
      toast.error("Transition rejected", { description: msg ?? undefined });
    },
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    code: newCode(),
    warehouse_id: "",
    source_doc_type: "",
    source_doc_id: "",
    appointment_id: "",
    notes: "",
  });

  // Deep-link binding: `Receive goods` from a purchase order or inbound
  // shipment lands here with the document already chosen, so the operator
  // never retypes a reference and the session is always bound to real
  // expected lines.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const type = searchParams.get("source_doc_type");
    const id = searchParams.get("source_doc_id");
    if (!type || !id) return;
    setForm((f) => ({
      ...f,
      code: newCode(),
      source_doc_type: type,
      source_doc_id: id,
      warehouse_id: f.warehouse_id || (warehouses.length === 1 ? warehouses[0].id : ""),
    }));
    setCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("source_doc_type");
    next.delete("source_doc_id");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, warehouses]);

  const create = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id || !currentOrg?.id) throw new Error("No active organization");
      if (!form.warehouse_id) throw new Error("Choose a warehouse");
      const wh = warehouses.find((w) => w.id === form.warehouse_id);
      const { data: created, error } = await supabase.from("wms_receiving_sessions" as any).insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        branch_id: wh?.branch_id ?? null,
        warehouse_id: form.warehouse_id,
        code: form.code.trim(),
        source_doc_type: form.source_doc_type || null,
        source_doc_id: form.source_doc_id || null,
        appointment_id: form.appointment_id || null,
        dock_id: form.appointment_id
          ? ((appointments ?? []).find((a) => a.id === form.appointment_id)?.dock_id ?? null)
          : null,
        supervisor_id: user?.id ?? null,
        state: "open",
        notes: form.notes || null,
        created_by: user?.id ?? null,
      }).select("id").single();
      if (error) throw error;
      const id = (created as unknown as { id: string } | null)?.id;
      if (id && form.source_doc_id) {
        // Expand the bound document into expected lines immediately.
        await materialize.mutateAsync(id).catch(() => undefined);
      }
    },
    onSuccess: () => {
      toast.success("Receiving session created");
      setCreateOpen(false);
      setForm({
        code: newCode(),
        warehouse_id: "",
        source_doc_type: "",
        source_doc_id: "",
        appointment_id: "",
        notes: "",
      });
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

  // Phase C2 — an item scan must resolve to a known product + packaging level
  // through `resolve_product_identity` BEFORE the session advances. An
  // unknown/ambiguous code blocks the line (scanFeedbackBus error), it is
  // never narrated as a success.
  const handleItemScan = useCallback(
    async (p: WmsScanPayload) => {
      // Plate labels reach this handler too (it outranks the LPN intent at the
      // same priority). A plate must start unloading, not fail the product gate.
      const plate = await tryResolvePlateScan(currentBusiness?.id, p.raw, p.isGs1);
      if (plate) {
        handleLpnScan({ ...p, resolveCode: plate.code });
        return;
      }
      if (unloadingSessions.length !== 1) {
        scanFeedbackBus.emit({
          kind: "error",
          raw: p.raw,
          source: "field",
          workflow: "receive",
          detail:
            unloadingSessions.length === 0
              ? "No session unloading — scan an LPN to start"
              : "Multiple sessions unloading — open one before scanning items",
        });
        return;
      }
      const gated = await identityGate.gate({ raw: p.raw, resolveCode: p.resolveCode, workflow: "receive" });
      if (!gated) return;

      const target = unloadingSessions[0];
      const { identity, baseUnits, lot, serial, expiry } = gated;
      try {
        // Line grain: the scan is recorded as received quantity against the
        // session's expected line. The session state is untouched — capture is
        // completed explicitly once the operator is done unloading.
        //
        // UoM authority: ONE scan of the matched packaging level is sent as the
        // entered quantity together with `packagingId`. The server multiplies
        // through `wms_to_base_qty` (canonical `product_packaging`); `baseUnits`
        // is operator PREVIEW text only and must never be the posted quantity —
        // a handheld with a stale packaging factor would otherwise book the
        // wrong base quantity into the ledger.
        const res = await captureLine.mutateAsync({
          sessionId: target.id,
          productId: identity.productId,
          receivedQty: 1,
          packagingId: identity.packagingId,
          lotNumber: lot,
          serialNumber: serial,
          expiryDate: expiry ? expiry.toISOString().slice(0, 10) : null,
          clientScanId: `${target.id}:${p.raw}:${Date.now()}`,
        });
        toast.success(`${identity.productName} +${baseUnits} on ${target.code}`, {
          description: [
            `${describeLevel(identity)} → ${baseUnits} base units`,
            lot ? `lot ${lot}` : null,
            res?.unexpected ? "not on the source document" : null,
          ].filter(Boolean).join(" · "),
        });

      } catch (e) {
        scanFeedbackBus.emit({
          kind: "error",
          raw: p.raw,
          source: "field",
          workflow: "receive",
          detail: e instanceof Error ? e.message : "Capture failed",
        });
      }
    },
    [unloadingSessions, identityGate, captureLine, currentBusiness?.id, handleLpnScan],
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
    enabled: !activeSession,
  });

  // Irreversible post confirmation. `captured → posted` = two-tap; `discrepant → posted` = typed ack.
  type PostConfirm = { session: SessionRow; from: "captured" | "discrepant" };
  const [postConfirm, setPostConfirm] = useState<PostConfirm | null>(null);
  const [postAck, setPostAck] = useState("");
  const requiresTyped = postConfirm?.from === "discrepant";
  const canConfirm = !requiresTyped || postAck.trim().toUpperCase() === "POST";
  const confirmPost = () => {
    if (!postConfirm || !canConfirm) return;
    const reason = postConfirm.from === "discrepant" ? "Posted with discrepancies" : undefined;
    transition.mutate(
      { id: postConfirm.session.id, to: "posted", rowVersion: postConfirm.session.row_version, reason },
      { onSuccess: () => toast.success(`Posted ${postConfirm.session.code} to inventory`) },
    );
    setPostConfirm(null);
    setPostAck("");
  };

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
        { label: "Post to inventory", icon: Check, run: () => setActiveSession(r) },
        { label: "Discrepant", icon: AlertTriangle, run: () => t("discrepant") },
      ];
      case "discrepant": return [
        { label: "Review & post", icon: Check, run: () => setActiveSession(r) },
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
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={stateFilter} onValueChange={setStateFilter}>
                <SelectTrigger className="w-full @xl/page:w-[180px]"><SelectValue /></SelectTrigger>
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
                <SelectTrigger className="w-full @xl/page:w-[180px]"><SelectValue placeholder="Warehouse" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All warehouses</SelectItem>
                  {warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <ToggleGroup
                type="single"
                value={view}
                onValueChange={(v) => v && setView(v as "board" | "table")}
                variant="outline"
                size="sm"
              >
                <ToggleGroupItem value="board" aria-label="Board view">
                  <LayoutGrid className="h-4 w-4" />
                </ToggleGroupItem>
                <ToggleGroupItem value="table" aria-label="Table view">
                  <Rows3 className="h-4 w-4" />
                </ToggleGroupItem>
              </ToggleGroup>
              <ScanGuidance
                expectedLabel="receiving-sessions.item"
                hint="Scan an LPN to start unloading, or an item to capture a line"
                variant="bar"
                className="ml-auto"
              />

            </div>

            {isLoading ? (
              <LoadingState />
            ) : (rows ?? []).length === 0 ? (
              <EmptyState icon={PackageOpen} title={emptyLabel} description="Create a session when a truck arrives or an ASN is opened." />
            ) : view === "board" ? (
              <ReceivingSessionBoard
                sessions={rows ?? []}
                progress={progress}
                dockLabel={dockLabel}
                appointment={appointmentFor}
                trailerVisit={trailerVisitFor}
                supervisorLabel={supervisorLabel}
                actions={nextActions}
                onOpen={(s) => setActiveSession(s as SessionRow)}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Dock</TableHead>
                    <TableHead>Lines</TableHead>
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
                      <TableCell className="text-xs text-muted-foreground">
                        {dockLabel(r.dock_id) ?? (r.appointment_id ? "appointment" : "unscheduled")}
                      </TableCell>
                      <TableCell className="text-xs">
                        {(() => {
                          const pr = progress?.get(r.id);
                          if (!pr || pr.line_count === 0) return <span className="text-muted-foreground">no lines</span>;
                          return (
                            <span className="space-x-1">
                              <span className="font-medium">{Number(pr.received_qty)}</span>
                              <span className="text-muted-foreground">/ {Number(pr.expected_qty)}</span>
                              {pr.short_lines > 0 && <StatusBadge tone="danger">{pr.short_lines} short</StatusBadge>}
                              {pr.over_lines > 0 && <StatusBadge tone="warning">{pr.over_lines} over</StatusBadge>}
                              {pr.unexpected_lines > 0 && <StatusBadge tone="warning">{pr.unexpected_lines} extra</StatusBadge>}
                              {pr.hold_lines > 0 && <StatusBadge tone="danger">{pr.hold_lines} hold</StatusBadge>}
                            </span>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.started_at ? new Date(r.started_at).toLocaleString() : "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.closed_at ? new Date(r.closed_at).toLocaleString() : "—"}</TableCell>
                      <TableCell className="text-right space-x-1">
                        <Button size="sm" variant="outline" onClick={() => setActiveSession(r)}>Open</Button>
                        <ActivityHistoryButton aggregateId={r.id} recordLabel={r.code} />
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
          </div>
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
            <div>
              <Label>Source document</Label>
              <Select
                value={form.source_doc_type || "none"}
                onValueChange={(v) => setForm({ ...form, source_doc_type: v === "none" ? "" : v, source_doc_id: "" })}
              >
                <SelectTrigger><SelectValue placeholder="Blind receipt" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Blind receipt (no document)</SelectItem>
                  <SelectItem value="purchase_order">Purchase order</SelectItem>
                  <SelectItem value="inbound_shipment">Inbound shipment (ASN)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.source_doc_type === "purchase_order" && (
              <div>
                <Label>Purchase order</Label>
                <Select value={form.source_doc_id} onValueChange={(v) => setForm({ ...form, source_doc_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Choose purchase order" /></SelectTrigger>
                  <SelectContent>
                    {(sourceDocs ?? []).map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.po_number ?? d.id.slice(0, 8)} · {d.status ?? "—"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Expected lines are loaded from this order so shortages and overages are measurable.
                </p>
              </div>
            )}
            {form.source_doc_type === "inbound_shipment" && (
              <div>
                <Label>Inbound shipment</Label>
                <Select value={form.source_doc_id} onValueChange={(v) => setForm({ ...form, source_doc_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Choose inbound shipment" /></SelectTrigger>
                  <SelectContent>
                    {(shipmentDocs ?? []).map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.shipment_number ?? d.id.slice(0, 8)} · {d.status ?? "—"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Expected lines come from the ASN; posting receives against the shipment.
                </p>
              </div>
            )}
            <div>
              <Label>Dock appointment</Label>
              <Select
                value={form.appointment_id || "none"}
                onValueChange={(v) => setForm({ ...form, appointment_id: v === "none" ? "" : v })}
              >
                <SelectTrigger><SelectValue placeholder="Unscheduled arrival" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unscheduled arrival (no appointment)</SelectItem>
                  {(appointments ?? [])
                    .filter((a) => !form.warehouse_id || a.warehouse_id === form.warehouse_id)
                    .map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {[
                          dockLabel(a.dock_id) ?? "dock",
                          a.reference ?? a.state,
                          new Date(a.window_start).toLocaleString(),
                        ].join(" · ")}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                Binds the session to the trailer's door and window; you become the supervisor of record.
              </p>
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

      <ReceivingSessionWorkspace
        session={activeSession}
        businessId={currentBusiness?.id}
        onClose={() => setActiveSession(null)}
      />

      <AlertDialog
        open={!!postConfirm}
        onOpenChange={(o) => { if (!o) { setPostConfirm(null); setPostAck(""); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {requiresTyped ? "Post discrepant session to inventory?" : "Post to inventory?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  Session <span className="font-mono font-medium">{postConfirm?.session.code}</span> will
                  commit received quantities to stock. This writes ledger movements, fires
                  replenishment and cross-dock evaluation, and <strong>cannot be undone</strong> from
                  this screen — reversal requires a compensating inventory movement.
                </p>
                {requiresTyped && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                    <p className="text-destructive font-medium">
                      This session is flagged discrepant. You are committing known-mismatched data.
                    </p>
                    <Label className="text-xs">Type <span className="font-mono">POST</span> to confirm</Label>
                    <Input
                      value={postAck}
                      onChange={(e) => setPostAck(e.target.value)}
                      placeholder="POST"
                      className="font-mono"
                      autoFocus
                    />
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmPost(); }}
              disabled={!canConfirm || transition.isPending}
              className={requiresTyped ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
            >
              {requiresTyped ? "Post anyway" : "Post to inventory"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
