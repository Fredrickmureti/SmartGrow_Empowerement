/**
 * QCInspectionDetail — record checks and drive the inspection to a
 * terminal state through the sanctioned RPCs.
 *
 * All writes call:
 *   record_qc_check
 *   accept_qc_inspection
 *   reject_qc_inspection
 *   cancel_qc_inspection
 */
import { useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ActivitySection } from "@/features/warehouse/events/ActivitySection";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  useAcceptQcInspection,
  useCancelQcInspection,
  useRejectQcInspection,
} from "@/features/warehouse/aggregates/useDomainOperations";
import { PageHeader, PageBody, Section, LoadingState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ShieldCheck, ArrowLeft, Check, X, Ban } from "lucide-react";

interface Inspection {
  id: string;
  warehouse_id: string;
  source_doc_type: string;
  source_doc_id: string | null;
  product_id: string | null;
  lot_number: string | null;
  serial_number: string | null;
  quantity: number;
  sample_size: number;
  sample_strategy: string;
  state: string;
  accepted_qty: number;
  rejected_qty: number;
  disposition: string | null;
  notes: string | null;
  inspected_at: string | null;
  products?: { name: string | null; sku: string | null } | null;
  warehouses?: { name: string | null } | null;
}

interface Check {
  id: string;
  check_code: string;
  check_label: string;
  expected: string | null;
  actual: string | null;
  pass: boolean | null;
  severity: string | null;
  photo_url: string | null;
  created_at: string;
}

export default function QCInspectionDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const insp = useQuery({
    queryKey: ["wms-qc-inspection", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_qc_inspections")
        .select("id, warehouse_id, source_doc_type, source_doc_id, product_id, lot_number, serial_number, quantity, sample_size, sample_strategy, state, accepted_qty, rejected_qty, disposition, notes, inspected_at, products(name, sku), warehouses(name)")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Inspection | null;
    },
    enabled: !!id,
  });

  const checks = useQuery({
    queryKey: ["wms-qc-checks", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_qc_inspection_checks")
        .select("id, check_code, check_label, expected, actual, pass, severity, photo_url, created_at")
        .eq("inspection_id", id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Check[];
    },
    enabled: !!id,
  });

  const [checkCode, setCheckCode] = useState("");
  const [checkLabel, setCheckLabel] = useState("");
  const [expected, setExpected] = useState("");
  const [actual, setActual] = useState("");
  const [severity, setSeverity] = useState<string>("minor");

  const recordCheck = useMutation({
    mutationFn: async (pass: boolean) => {
      if (!checkCode || !checkLabel) throw new Error("code and label required");
      const { error } = await supabase.rpc("record_qc_check", {
        p_inspection_id: id,
        p_check_code: checkCode,
        p_check_label: checkLabel,
        p_expected: expected || null,
        p_actual: actual || null,
        p_pass: pass,
        p_severity: severity,
        p_photo_url: null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Check recorded");
      setCheckCode(""); setCheckLabel(""); setExpected(""); setActual("");
      qc.invalidateQueries({ queryKey: ["wms-qc-checks", id] });
      qc.invalidateQueries({ queryKey: ["wms-qc-inspection", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [acceptQty, setAcceptQty] = useState<string>("");
  const [rejectQty, setRejectQty] = useState<string>("");
  const [disposition, setDisposition] = useState<string>("return_to_vendor");
  const [notes, setNotes] = useState("");

  const acceptMut = useAcceptQcInspection(id);
  const accept = {
    isPending: acceptMut.isPending,
    mutate: () => {
      const qty = Number(acceptQty);
      if (!Number.isFinite(qty) || qty < 0) return toast.error("valid accepted qty required");
      acceptMut.mutate(
        { acceptedQty: qty, notes: notes || null },
        { onSuccess: () => toast.success("Inspection accepted") },
      );
    },
  };

  const rejectMut = useRejectQcInspection(id);
  const reject = {
    isPending: rejectMut.isPending,
    mutate: () => {
      const qty = Number(rejectQty);
      if (!Number.isFinite(qty) || qty <= 0) return toast.error("valid rejected qty required");
      rejectMut.mutate(
        { rejectedQty: qty, disposition, notes: notes || null },
        { onSuccess: () => toast.success("Inspection rejected") },
      );
    },
  };

  const cancelMut = useCancelQcInspection(id);
  const cancel = {
    isPending: cancelMut.isPending,
    mutate: () => {
      const reason = window.prompt("Cancellation reason?") ?? "";
      if (!reason) return;
      cancelMut.mutate(reason, { onSuccess: () => toast.success("Inspection cancelled") });
    },
  };

  if (insp.isLoading) return <LoadingState />;
  const row = insp.data;
  if (!row) return <div className="p-6">Inspection not found. <Link to="/warehouse-app/qc" className="underline">Back to queue</Link></div>;

  const isTerminal = ["accepted", "partially_accepted", "rejected", "cancelled"].includes(row.state);
  const remaining = row.quantity - row.accepted_qty - row.rejected_qty;

  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" />{row.products?.name ?? "QC inspection"}</span>}
        description={`${row.warehouses?.name ?? ""} · qty ${row.quantity} · ${row.source_doc_type.replace("_", " ")}`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => navigate("/warehouse-app/qc")}><ArrowLeft className="h-4 w-4 mr-1" />Back</Button>
            <Badge>{row.state.replace("_", " ")}</Badge>
          </div>
        }
      />
      <PageBody>
        <div className="min-w-0 grid gap-4 @4xl/page:grid-cols-2">
          <Section title="Checks">
            <div className="space-y-3">
                <div className="divide-y">
                  {(checks.data ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">No checks recorded yet.</p>
                  ) : (checks.data ?? []).map((c) => (
                    <div key={c.id} className="py-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{c.check_label} <span className="text-xs text-muted-foreground">({c.check_code})</span></p>
                        <p className="text-xs text-muted-foreground">expected: {c.expected ?? "—"} · actual: {c.actual ?? "—"} · {c.severity ?? "minor"}</p>
                      </div>
                      <Badge variant={c.pass ? "secondary" : "destructive"}>{c.pass ? "PASS" : "FAIL"}</Badge>
                    </div>
                  ))}
                </div>
                {!isTerminal && (
                  <div className="grid gap-2 border-t pt-3">
                    <div className="min-w-0 grid grid-cols-2 gap-2">
                      <div><Label className="text-xs">Code</Label><Input value={checkCode} onChange={(e) => setCheckCode(e.target.value)} placeholder="visual-01" /></div>
                      <div><Label className="text-xs">Label</Label><Input value={checkLabel} onChange={(e) => setCheckLabel(e.target.value)} placeholder="Visual inspection" /></div>
                      <div><Label className="text-xs">Expected</Label><Input value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
                      <div><Label className="text-xs">Actual</Label><Input value={actual} onChange={(e) => setActual(e.target.value)} /></div>
                    </div>
                    <div className="flex items-center gap-2">
                      <select className="border rounded px-2 py-1 bg-background text-sm" value={severity} onChange={(e) => setSeverity(e.target.value)}>
                        <option value="minor">minor</option>
                        <option value="major">major</option>
                        <option value="critical">critical</option>
                      </select>
                      <Button size="sm" variant="secondary" onClick={() => recordCheck.mutate(true)} disabled={recordCheck.isPending}><Check className="h-4 w-4 mr-1" />Pass</Button>
                      <Button size="sm" variant="destructive" onClick={() => recordCheck.mutate(false)} disabled={recordCheck.isPending}><X className="h-4 w-4 mr-1" />Fail</Button>
                    </div>
                  </div>
                )}
            </div>
          </Section>

          <Section title="Disposition">
            <div className="space-y-3">
                <div className="min-w-0 grid grid-cols-3 gap-2 text-sm">
                  <div><p className="text-muted-foreground">Total</p><p className="font-medium">{row.quantity}</p></div>
                  <div><p className="text-muted-foreground">Accepted</p><p className="font-medium">{row.accepted_qty}</p></div>
                  <div><p className="text-muted-foreground">Rejected</p><p className="font-medium">{row.rejected_qty}</p></div>
                </div>
                {isTerminal ? (
                  <p className="text-sm text-muted-foreground">Inspection finalized{row.disposition ? ` — ${row.disposition.replace(/_/g, " ")}` : ""}.</p>
                ) : (
                  <>
                    <div>
                      <Label>Notes</Label>
                      <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
                    </div>
                    <div className="border-t pt-3 grid gap-2">
                      <Label className="text-xs">Accept quantity (≤ {row.quantity})</Label>
                      <div className="flex gap-2">
                        <Input type="number" min={0} max={row.quantity} value={acceptQty} onChange={(e) => setAcceptQty(e.target.value)} />
                        <Button onClick={() => accept.mutate()} disabled={accept.isPending}><Check className="h-4 w-4 mr-1" />Accept</Button>
                      </div>
                    </div>
                    <div className="border-t pt-3 grid gap-2">
                      <Label className="text-xs">Reject quantity + disposition</Label>
                      <div className="flex gap-2">
                        <Input type="number" min={0} max={row.quantity} value={rejectQty} onChange={(e) => setRejectQty(e.target.value)} />
                        <select className="border rounded px-2 py-1 bg-background text-sm" value={disposition} onChange={(e) => setDisposition(e.target.value)}>
                          <option value="return_to_vendor">Return to vendor</option>
                          <option value="scrap">Scrap</option>
                          <option value="rework">Rework</option>
                          <option value="use_as_is">Use as-is</option>
                        </select>
                        <Button variant="destructive" onClick={() => reject.mutate()} disabled={reject.isPending}><X className="h-4 w-4 mr-1" />Reject</Button>
                      </div>
                      <p className="text-xs text-muted-foreground">Remaining un-dispositioned: {remaining}</p>
                    </div>
                    <div className="border-t pt-3">
                      <Button variant="outline" size="sm" onClick={() => cancel.mutate()} disabled={cancel.isPending}><Ban className="h-4 w-4 mr-1" />Cancel inspection</Button>
                    </div>
                  </>
                )}
            </div>
          </Section>
        </div>
        <ActivitySection aggregateId={id} title="Inspection activity" description="Lifecycle events emitted for this QC inspection." />
      </PageBody>
    </>
  );
}