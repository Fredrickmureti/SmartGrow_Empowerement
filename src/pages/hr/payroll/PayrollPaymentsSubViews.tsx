/**
 * Payroll Payments — sub-views (Failed items, Bank export files, Register).
 * Phase F. Reads-only views off `v_payroll_payment_reconciliation` and the
 * Phase B/C tables. Includes a client-side CSV register export.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { format } from "date-fns";
import { toast } from "sonner";
import { usePayrollPayments } from "@/hooks/payroll/usePayrollPayments";

import { buildCsv, downloadCsv as canonicalDownloadCsv } from "@/lib/exports/csv";

function downloadCsv(filename: string, rows: Record<string, any>[]) {
  if (!rows.length) { toast.error("No rows to export"); return; }
  const cols = Object.keys(rows[0]);
  canonicalDownloadCsv(filename, buildCsv(rows, cols));
}

// ────────────────────────────────────────────────────────────────────────
// Failed items page — every batch item in `failed` status across the org
// ────────────────────────────────────────────────────────────────────────
export function PayrollPaymentsFailedPage() {
  const { retryItem, cancelItem, markItemPaid, holdItem, releaseItem } = usePayrollPayments();
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const { data, isLoading } = useQuery({
    queryKey: ["payroll-failed-items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_payment_batch_items")
        .select("id, batch_id, employee_id, amount, failure_reason, failed_at, retry_count, item_status")
        .in("item_status", ["failed", "held"])
        .order("failed_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  const pending =
    retryItem.isPending || cancelItem.isPending || markItemPaid.isPending ||
    holdItem.isPending || releaseItem.isPending;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Failed payroll payments</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild><Link to="/hr/payroll/payments">Back to Payments</Link></Button>
          <Button variant="outline" size="sm" onClick={() => downloadCsv("payroll-failed-items.csv", (data ?? []) as any[])}>Export CSV</Button>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {isLoading ? <p className="p-4 text-sm">Loading…</p> : (data ?? []).length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No failed or held items.</p>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Failed at</TableHead><TableHead>Status</TableHead>
                <TableHead>Employee</TableHead><TableHead>Batch</TableHead>
                <TableHead className="text-right">Amount</TableHead><TableHead>Retries</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-72">Note / reference</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {(data ?? []).map((it: any) => {
                  const reason = reasonById[it.id] ?? "";
                  const isFailed = it.item_status === "failed";
                  const isHeld = it.item_status === "held";
                  return (
                    <TableRow key={it.id}>
                      <TableCell className="text-xs">{it.failed_at ? format(new Date(it.failed_at), "MMM d, HH:mm") : "—"}</TableCell>
                      <TableCell><Badge variant={isFailed ? "destructive" : "outline"}>{it.item_status}</Badge></TableCell>
                      <TableCell className="font-mono text-xs">{String(it.employee_id).slice(0, 8)}</TableCell>
                      <TableCell className="font-mono text-xs">{String(it.batch_id).slice(0, 8)}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(it.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</TableCell>
                      <TableCell>{it.retry_count ?? 0}</TableCell>
                      <TableCell className="max-w-md truncate text-xs text-muted-foreground">{it.failure_reason || "—"}</TableCell>
                      <TableCell>
                        <Input
                          value={reason}
                          onChange={(e) => setReasonById((m) => ({ ...m, [it.id]: e.target.value }))}
                          placeholder={isFailed ? "Retry note / cancel reason" : "Release / cancel reason"}
                          className="h-8 text-xs"
                        />
                      </TableCell>
                      <TableCell className="text-right space-x-1 whitespace-nowrap">
                        {isFailed && (
                          <>
                            <Button size="sm" variant="outline" disabled={pending}
                              onClick={() => retryItem.mutate({ item_id: it.id })}>Retry</Button>
                            <Button size="sm" variant="outline" disabled={pending}
                              onClick={() => markItemPaid.mutate({ item_id: it.id, payment_reference: reason || undefined })}>Mark paid</Button>
                            <Button size="sm" variant="outline" disabled={pending}
                              onClick={() => holdItem.mutate({ item_id: it.id, reason: reason || "(no reason)" })}>Hold</Button>
                          </>
                        )}
                        {isHeld && (
                          <Button size="sm" variant="outline" disabled={pending}
                            onClick={() => releaseItem.mutate({ item_id: it.id })}>Release</Button>
                        )}
                        <Button size="sm" variant="ghost" className="text-destructive" disabled={pending}
                          onClick={() => cancelItem.mutate({ item_id: it.id, reason: reason || "" })}>Cancel</Button>
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
  );
}

// ────────────────────────────────────────────────────────────────────────
// Bank export files page — every bank disbursement file with status
// ────────────────────────────────────────────────────────────────────────
const fileStatusVariant: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  generated: "secondary", transmitted: "outline", acknowledged: "default",
  rejected: "destructive", cancelled: "outline",
};

export function PayrollBankExportFilesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["payroll-bank-export-files"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_bank_export_files")
        .select("id, batch_id, format_code, file_name, status, line_count, total_amount, generated_at, transmitted_at, acknowledged_at, rejection_reason, acknowledgement_reference")
        .order("generated_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Bank export files</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild><Link to="/hr/payroll/payments">Back to Payments</Link></Button>
          <Button variant="outline" size="sm" onClick={() => downloadCsv("payroll-bank-export-files.csv", (data ?? []) as any[])}>Export CSV</Button>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {isLoading ? <p className="p-4 text-sm">Loading…</p> : (data ?? []).length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No bank export files yet.</p>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Generated</TableHead><TableHead>File</TableHead><TableHead>Format</TableHead>
                <TableHead>Status</TableHead><TableHead>Ack ref</TableHead>
                <TableHead className="text-right">Lines</TableHead><TableHead className="text-right">Total</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {(data ?? []).map((f: any) => (
                  <TableRow key={f.id}>
                    <TableCell className="text-xs">{format(new Date(f.generated_at), "MMM d, HH:mm")}</TableCell>
                    <TableCell className="font-mono text-xs">{f.file_name}</TableCell>
                    <TableCell className="text-xs">{f.format_code}</TableCell>
                    <TableCell><Badge variant={fileStatusVariant[f.status] ?? "outline"}>{f.status}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{f.acknowledgement_reference || f.rejection_reason || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.line_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(f.total_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Payments register — flat audit-friendly view, CSV exportable
// ────────────────────────────────────────────────────────────────────────
export function PayrollPaymentsRegisterPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["payroll-payments-register"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_payroll_payment_reconciliation" as any)
        .select("*")
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const totals = useMemo(() => {
    const rows = data ?? [];
    return {
      count: rows.length,
      total: rows.reduce((s, r) => s + Number(r.total_amount || 0), 0),
      paid: rows.reduce((s, r) => s + Number(r.amount_paid || 0), 0),
    };
  }, [data]);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Payments register</h1>
          <p className="text-xs text-muted-foreground">
            {totals.count} batches · total {totals.total.toLocaleString(undefined, { minimumFractionDigits: 2 })} · paid {totals.paid.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild><Link to="/hr/payroll/payments">Back to Payments</Link></Button>
          <Button variant="outline" size="sm" onClick={() => downloadCsv("payroll-payments-register.csv", (data ?? []) as any[])}>Export CSV</Button>
        </div>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">All payment batches</CardTitle></CardHeader>
        <CardContent className="p-0">
          {isLoading ? <p className="p-4 text-sm">Loading…</p> : (data ?? []).length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No payment batches.</p>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Batch</TableHead><TableHead>Status</TableHead><TableHead>Recon</TableHead>
                <TableHead>JE #</TableHead><TableHead>Payment date</TableHead>
                <TableHead className="text-right">Total</TableHead><TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Items</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {(data ?? []).map((r: any) => (
                  <TableRow key={r.batch_id}>
                    <TableCell className="font-mono text-xs">{r.batch_number}</TableCell>
                    <TableCell><Badge variant="outline">{r.batch_status}</Badge></TableCell>
                    <TableCell><Badge variant="outline">{r.reconciliation_state}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{r.journal_entry_number || "—"}</TableCell>
                    <TableCell className="text-xs">{r.payment_date ? format(new Date(r.payment_date), "MMM d, yyyy") : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(r.total_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(r.amount_paid).toLocaleString(undefined, { minimumFractionDigits: 2 })}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{r.items_paid}/{r.items_total}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
