/**
 * Legal Order Remittance Batches — Phase 7 step 1.
 *
 * The planning-side of the remittance cycle: bundle a recipient's
 * pending accruals for a period into a single draft batch, generate a
 * bank file (deterministic pack-agnostic body + sha256 checksum), then
 * settle the batch which projects each batch line into
 * `legal_order_remittance_lines` and runs `legal_order_auto_satisfy`.
 *
 * Writers all go through RPCs:
 *   - legal_order_build_remittance_batch
 *   - legal_order_generate_remittance_bank_file
 *   - legal_order_settle_remittance_batch
 *   - legal_order_cancel_remittance_batch
 *
 * No status is flipped directly; FSM stays writer-guarded.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useLegalRecipientOutstanding } from "@/hooks/useLegalRecipients";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Ban, FileDown, PlayCircle, Landmark, Link2 } from "lucide-react";

type BatchStatus = "draft" | "generated" | "settled" | "cancelled";

interface RemittanceBatch {
  id: string;
  organization_id: string;
  business_id: string | null;
  recipient_id: string;
  batch_number: string;
  status: BatchStatus;
  period_from: string;
  period_to: string;
  planned_total: number;
  planned_line_count: number;
  bank_file_format: string | null;
  bank_file_checksum: string | null;
  bank_file_generated_at: string | null;
  settled_at: string | null;
  settled_payment_date: string | null;
  settled_reference: string | null;
  settled_bank_transaction_id: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  notes: string | null;
  created_at: string;
  legal_recipients?: { display_name: string; recipient_type_code: string } | null;
}

function fmtMoney(n: number | null | undefined): string {
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n ?? 0));
}

function statusVariant(s: BatchStatus): "default" | "secondary" | "outline" | "destructive" {
  switch (s) {
    case "draft": return "outline";
    case "generated": return "secondary";
    case "settled": return "default";
    case "cancelled": return "destructive";
  }
}

export default function LegalOrderRemittanceBatches() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();
  const orgId = currentOrg?.id ?? null;
  const bizId = currentBusiness?.id ?? null;

  const [buildOpen, setBuildOpen] = useState(false);
  const [settleTarget, setSettleTarget] = useState<RemittanceBatch | null>(null);
  const [matchTarget, setMatchTarget] = useState<RemittanceBatch | null>(null);
  const [previewBody, setPreviewBody] = useState<{ batch: RemittanceBatch; body: string; checksum: string; format: string } | null>(null);

  const { data: recipients = [] } = useLegalRecipientOutstanding();

  const batchesQ = useQuery<RemittanceBatch[]>({
    queryKey: ["legal-order-remittance-batches", orgId, bizId],
    enabled: !!orgId,
    queryFn: async () => {
      let q = (supabase as any)
        .from("legal_order_remittance_batches")
        .select(`
          id, organization_id, business_id, recipient_id, batch_number, status,
          period_from, period_to, planned_total, planned_line_count,
          bank_file_format, bank_file_checksum, bank_file_generated_at,
          settled_at, settled_payment_date, settled_reference, settled_bank_transaction_id,
          cancelled_at, cancelled_reason, notes, created_at,
          legal_recipients:recipient_id ( display_name, recipient_type_code )
        `)
        .eq("organization_id", orgId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (bizId) q = q.eq("business_id", bizId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as RemittanceBatch[];
    },
  });

  const buildMut = useMutation({
    mutationFn: async (v: { recipient_id: string; period_from: string; period_to: string; notes: string | null }) => {
      const { data, error } = await (supabase as any).rpc("legal_order_build_remittance_batch", {
        p_organization_id: orgId,
        p_business_id: bizId,
        p_recipient_id: v.recipient_id,
        p_period_from: v.period_from,
        p_period_to: v.period_to,
        p_notes: v.notes,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: async () => {
      toast.success("Batch built");
      setBuildOpen(false);
      await qc.invalidateQueries({ queryKey: ["legal-order-remittance-batches"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Build failed"),
  });

  const generateMut = useMutation({
    mutationFn: async (v: { batch_id: string; format: string }) => {
      const { data, error } = await (supabase as any).rpc("legal_order_generate_remittance_bank_file", {
        p_batch_id: v.batch_id,
        p_format: v.format,
      });
      if (error) throw error;
      return data as { batch_number: string; body: string; checksum: string; format: string; byte_size: number };
    },
    onSuccess: async (res, vars) => {
      toast.success(`Bank file generated (${res.byte_size} bytes)`);
      await qc.invalidateQueries({ queryKey: ["legal-order-remittance-batches"] });
      const batch = (batchesQ.data ?? []).find((b) => b.id === vars.batch_id);
      if (batch) setPreviewBody({ batch, body: res.body, checksum: res.checksum, format: res.format });
    },
    onError: (e: any) => toast.error(e?.message ?? "Generate failed"),
  });

  const settleMut = useMutation({
    mutationFn: async (v: { batch_id: string; payment_date: string; reference: string | null }) => {
      const { data, error } = await (supabase as any).rpc("legal_order_settle_remittance_batch", {
        p_batch_id: v.batch_id,
        p_payment_date: v.payment_date,
        p_reference: v.reference,
        p_bank_transaction_id: null,
      });
      if (error) throw error;
      return data as { settled_lines: number; settled_total: number };
    },
    onSuccess: async (res) => {
      toast.success(`Settled ${res.settled_lines} line${res.settled_lines === 1 ? "" : "s"} · ${fmtMoney(res.settled_total)}`);
      setSettleTarget(null);
      await qc.invalidateQueries({ queryKey: ["legal-order-remittance-batches"] });
      await qc.invalidateQueries({ queryKey: ["legal-recipient-outstanding"] });
      await qc.invalidateQueries({ queryKey: ["legal-order-remittance-lines"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Settle failed"),
  });

  const cancelMut = useMutation({
    mutationFn: async (v: { batch_id: string; reason: string }) => {
      const { error } = await (supabase as any).rpc("legal_order_cancel_remittance_batch", {
        p_batch_id: v.batch_id,
        p_reason: v.reason,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      toast.success("Batch cancelled");
      await qc.invalidateQueries({ queryKey: ["legal-order-remittance-batches"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Cancel failed"),
  });

  const matchMut = useMutation({
    mutationFn: async (v: { batch_id: string; bank_transaction_id: string }) => {
      const { data, error } = await (supabase as any).rpc("legal_order_match_batch_to_bank_txn", {
        _batch_id: v.batch_id,
        _bank_transaction_id: v.bank_transaction_id,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: async () => {
      toast.success("Matched to bank transaction");
      setMatchTarget(null);
      await qc.invalidateQueries({ queryKey: ["legal-order-remittance-batches"] });
      await qc.invalidateQueries({ queryKey: ["bank-reconciliation-matches"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Match failed"),
  });

  const rows = batchesQ.data ?? [];
  const totals = useMemo(() => ({
    total: rows.length,
    draft: rows.filter((r) => r.status === "draft").length,
    generated: rows.filter((r) => r.status === "generated").length,
    settled: rows.filter((r) => r.status === "settled").length,
    plannedOpen: rows.filter((r) => r.status === "draft" || r.status === "generated")
      .reduce((s, r) => s + Number(r.planned_total ?? 0), 0),
  }), [rows]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Remittance batches</h1>
          <p className="text-sm text-muted-foreground">
            Build, generate a bank file, and settle recipient-scoped legal-order payment batches.
          </p>
        </div>
        <Button onClick={() => setBuildOpen(true)} disabled={!orgId}>
          <PlayCircle className="h-4 w-4 mr-2" /> Build batch
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground">
            {totals.total} batch{totals.total === 1 ? "" : "es"} · {totals.draft} draft · {totals.generated} generated · {totals.settled} settled
            {" · "}<span className="text-foreground font-medium">{fmtMoney(totals.plannedOpen)}</span> planned open
          </CardTitle>
        </CardHeader>
        <CardContent>
          {batchesQ.isLoading ? (
            <p className="text-sm">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No batches yet. Click <span className="font-medium">Build batch</span> to bundle a recipient's pending accruals.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch #</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Planned</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-mono text-xs">{b.batch_number}</TableCell>
                    <TableCell>
                      <div className="text-sm">{b.legal_recipients?.display_name ?? "—"}</div>
                      <div className="text-[10px] text-muted-foreground">{b.legal_recipients?.recipient_type_code ?? ""}</div>
                    </TableCell>
                    <TableCell className="text-xs">{b.period_from} → {b.period_to}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(b.status)} className="capitalize">{b.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs">{b.planned_line_count}</TableCell>
                    <TableCell className="text-right">{fmtMoney(b.planned_total)}</TableCell>
                    <TableCell className="text-xs">
                      {b.bank_file_format ? (
                        <span title={b.bank_file_checksum ?? ""} className="font-mono">
                          {b.bank_file_format} · {b.bank_file_checksum?.slice(0, 8)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right space-x-1">
                      {(b.status === "draft" || b.status === "generated") && b.planned_line_count > 0 && (
                        <Button size="sm" variant="outline"
                          onClick={() => generateMut.mutate({ batch_id: b.id, format: "csv" })}
                          disabled={generateMut.isPending}>
                          <FileDown className="h-3.5 w-3.5 mr-1" /> Generate
                        </Button>
                      )}
                      {b.status === "generated" && (
                        <Button size="sm" onClick={() => setSettleTarget(b)}>
                          <Landmark className="h-3.5 w-3.5 mr-1" /> Settle
                        </Button>
                      )}
                      {b.status === "settled" && !b.settled_bank_transaction_id && (
                        <Button size="sm" variant="outline" onClick={() => setMatchTarget(b)}>
                          <Link2 className="h-3.5 w-3.5 mr-1" /> Match
                        </Button>
                      )}
                      {b.status === "settled" && b.settled_bank_transaction_id && (
                        <Badge variant="outline" className="text-[10px]">matched</Badge>
                      )}
                      {(b.status === "draft" || b.status === "generated") && (
                        <Button size="sm" variant="ghost"
                          onClick={() => cancelMut.mutate({ batch_id: b.id, reason: "manual_cancel" })}
                          disabled={cancelMut.isPending}>
                          <Ban className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Build dialog */}
      <BuildBatchDialog
        open={buildOpen}
        onOpenChange={setBuildOpen}
        recipients={recipients}
        onSubmit={(v) => buildMut.mutate(v)}
        submitting={buildMut.isPending}
      />

      {/* Match to bank transaction dialog */}
      <MatchBatchDialog
        target={matchTarget}
        orgId={orgId}
        onClose={() => setMatchTarget(null)}
        onSubmit={(v) => matchTarget && matchMut.mutate({ batch_id: matchTarget.id, bank_transaction_id: v.bank_transaction_id })}
        submitting={matchMut.isPending}
      />


      {/* Settle dialog */}
      <SettleBatchDialog
        target={settleTarget}
        onClose={() => setSettleTarget(null)}
        onSubmit={(v) => settleTarget && settleMut.mutate({ batch_id: settleTarget.id, ...v })}
        submitting={settleMut.isPending}
      />

      {/* Bank file preview */}
      <Dialog open={!!previewBody} onOpenChange={(o) => !o && setPreviewBody(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Bank file · {previewBody?.batch.batch_number}</DialogTitle>
            <DialogDescription>
              Format {previewBody?.format} · sha256 <span className="font-mono">{previewBody?.checksum.slice(0, 16)}…</span>
            </DialogDescription>
          </DialogHeader>
          <pre className="text-xs bg-muted rounded p-3 max-h-[50vh] overflow-auto whitespace-pre-wrap">
            {previewBody?.body}
          </pre>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (!previewBody) return;
                const blob = new Blob([previewBody.body], { type: "text/plain;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${previewBody.batch.batch_number}.${previewBody.format === "csv" ? "csv" : "txt"}`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function BuildBatchDialog({
  open, onOpenChange, recipients, onSubmit, submitting,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  recipients: Array<{ recipient_id: string; display_name: string; outstanding_balance: number; is_linked_to_contact: boolean }>;
  onSubmit: (v: { recipient_id: string; period_from: string; period_to: string; notes: string | null }) => void;
  submitting: boolean;
}) {
  const [recipientId, setRecipientId] = useState<string>("");
  const [from, setFrom] = useState(() => format(startOfMonth(new Date()), "yyyy-MM-dd"));
  const [to, setTo] = useState(() => format(endOfMonth(new Date()), "yyyy-MM-dd"));
  const [notes, setNotes] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Build remittance batch</DialogTitle>
          <DialogDescription>
            Aggregates the recipient's pending accruals in the selected period into a single draft batch.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Recipient</Label>
            <Select value={recipientId} onValueChange={setRecipientId}>
              <SelectTrigger><SelectValue placeholder="Select a recipient" /></SelectTrigger>
              <SelectContent>
                {recipients
                  .filter((r) => Number(r.outstanding_balance ?? 0) > 0)
                  .map((r) => (
                    <SelectItem key={r.recipient_id} value={r.recipient_id}>
                      {r.display_name} · outstanding {fmtMoney(r.outstanding_balance)}
                      {!r.is_linked_to_contact && " · unlinked"}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>From</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!recipientId || submitting}
            onClick={() => onSubmit({ recipient_id: recipientId, period_from: from, period_to: to, notes: notes || null })}
          >
            {submitting ? "Building…" : "Build"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettleBatchDialog({
  target, onClose, onSubmit, submitting,
}: {
  target: RemittanceBatch | null;
  onClose: () => void;
  onSubmit: (v: { payment_date: string; reference: string | null }) => void;
  submitting: boolean;
}) {
  const [paymentDate, setPaymentDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [reference, setReference] = useState("");

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settle batch · {target?.batch_number}</DialogTitle>
          <DialogDescription>
            Records {target?.planned_line_count} remittance line{target?.planned_line_count === 1 ? "" : "s"} totalling{" "}
            <span className="font-medium">{fmtMoney(target?.planned_total)}</span> and auto-satisfies any fully paid orders.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Payment date</Label>
            <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Reference</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={target?.batch_number ?? "Bank reference"} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={submitting}
            onClick={() => onSubmit({ payment_date: paymentDate, reference: reference || null })}
          >
            {submitting ? "Settling…" : "Settle"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MatchBatchDialog({
  target, orgId, onClose, onSubmit, submitting,
}: {
  target: RemittanceBatch | null;
  orgId: string | null;
  onClose: () => void;
  onSubmit: (v: { bank_transaction_id: string }) => void;
  submitting: boolean;
}) {
  const [selected, setSelected] = useState<string>("");

  // Load unmatched bank transactions near the batch settled date and amount.
  const { data: candidates = [] } = useQuery({
    queryKey: ["bank-txn-candidates-for-batch", target?.id, orgId],
    enabled: !!target && !!orgId,
    queryFn: async () => {
      if (!target || !orgId) return [];
      const centre = target.settled_payment_date ?? target.bank_file_generated_at ?? target.created_at;
      const from = new Date(centre);
      from.setDate(from.getDate() - 7);
      const to = new Date(centre);
      to.setDate(to.getDate() + 7);
      const { data, error } = await (supabase as any)
        .from("bank_transactions")
        .select("id, transaction_date, description, amount, reference_number, matched_status")
        .eq("organization_id", orgId)
        .gte("transaction_date", format(from, "yyyy-MM-dd"))
        .lte("transaction_date", format(to, "yyyy-MM-dd"))
        .in("matched_status", ["unmatched", "partial"])
        .order("transaction_date", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string; transaction_date: string; description: string | null;
        amount: number; reference_number: string | null; matched_status: string;
      }>;
    },
  });

  const amountHint = target ? Number(target.planned_total) : 0;

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Match to bank transaction · {target?.batch_number}</DialogTitle>
          <DialogDescription>
            Link the settled batch of {fmtMoney(amountHint)} to the incoming bank debit for full-cycle reconciliation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-[50vh] overflow-auto">
          {candidates.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No unmatched bank transactions in the ±7 day window.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((c) => {
                  const isMatch = Math.abs(Number(c.amount) - amountHint) < 0.01;
                  return (
                    <TableRow
                      key={c.id}
                      className={selected === c.id ? "bg-muted/50" : "cursor-pointer"}
                      onClick={() => setSelected(c.id)}
                    >
                      <TableCell>
                        <input type="radio" checked={selected === c.id} onChange={() => setSelected(c.id)} />
                      </TableCell>
                      <TableCell className="text-xs">{c.transaction_date}</TableCell>
                      <TableCell className="text-xs">{c.description ?? "—"}</TableCell>
                      <TableCell className="text-xs font-mono">{c.reference_number ?? "—"}</TableCell>
                      <TableCell className="text-right text-xs">
                        {fmtMoney(Math.abs(Number(c.amount)))}
                        {isMatch && <Badge variant="outline" className="ml-2 text-[10px]">exact</Badge>}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!selected || submitting}
            onClick={() => onSubmit({ bank_transaction_id: selected })}
          >
            {submitting ? "Matching…" : "Match"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
