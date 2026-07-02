/**
 * PayrollPaymentBatchItemsDialog
 *
 * Per-item drill-down for a payroll payment batch. Surfaces the per-item
 * state machine (pending / held / exported / sent / paid / failed /
 * cancelled / reversed) and exposes the lifecycle RPCs added in Phase B:
 *   - payroll_payment_item_hold
 *   - payroll_payment_item_release
 *   - payroll_payment_item_cancel
 *   - payroll_payment_item_retry
 *
 * Read-only for users without `payPayroll`.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { usePermissions } from "@/hooks/usePermissions";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

type ItemStatus =
  | "pending" | "held" | "exported" | "sent"
  | "paid" | "failed" | "cancelled" | "reversed";

const statusVariant: Record<ItemStatus, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  held: "outline",
  exported: "outline",
  sent: "outline",
  paid: "default",
  failed: "destructive",
  cancelled: "outline",
  reversed: "destructive",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batchId: string | null;
  batchNumber?: string;
}

export function PayrollPaymentBatchItemsDialog({ open, onOpenChange, batchId, batchNumber }: Props) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canManage = can("payPayroll");
  const [reasonById, setReasonById] = useState<Record<string, string>>({});

  const { data: items, isLoading } = useQuery({
    enabled: open && !!batchId,
    queryKey: ["payroll-payment-batch-items", batchId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payroll_payment_batch_items")
        .select("id, employee_id, amount, item_status, payment_reference, failure_reason, held_reason, retry_count, paid_at, sent_at, exported_at, failed_at")
        .eq("batch_id", batchId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const refetch = () => qc.invalidateQueries({ queryKey: ["payroll-payment-batch-items", batchId] });

  const hold = useMutation({
    mutationFn: async (id: string) => {
      const reason = (reasonById[id] || "").trim();
      if (reason.length < 3) throw new Error("Hold reason required (min 3 chars)");
      const { error } = await supabase.rpc("payroll_payment_item_hold", { _item_id: id, _reason: reason });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Item held"); refetch(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Hold failed"),
  });

  const release = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("payroll_payment_item_release", { _item_id: id });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Item released"); refetch(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Release failed"),
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const reason = (reasonById[id] || "").trim();
      if (reason.length < 3) throw new Error("Cancel reason required (min 3 chars)");
      const { error } = await supabase.rpc("payroll_payment_item_cancel", { _item_id: id, _reason: reason });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Item cancelled"); refetch(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Cancel failed"),
  });

  const retry = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("payroll_payment_item_retry", { _item_id: id });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Item queued for retry"); refetch(); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Retry failed"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Batch items {batchNumber ? `· ${batchNumber}` : ""}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !items || items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No items.</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Reference / Note</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((it: any) => {
                  const s = it.item_status as ItemStatus;
                  const isTerminal = s === "paid" || s === "cancelled" || s === "reversed";
                  return (
                    <TableRow key={it.id}>
                      <TableCell className="font-mono text-xs">{String(it.employee_id).slice(0, 8)}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant[s] ?? "outline"}>{s}</Badge>
                        {it.retry_count > 0 && (
                          <span className="ml-2 text-xs text-muted-foreground">×{it.retry_count}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {Number(it.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {it.payment_reference || it.failure_reason || it.held_reason || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage && !isTerminal && (
                          <div className="flex items-center justify-end gap-1">
                            {(s === "pending" || s === "held" || s === "failed") && (
                              <Input
                                value={reasonById[it.id] || ""}
                                onChange={(e) => setReasonById((m) => ({ ...m, [it.id]: e.target.value }))}
                                placeholder="Reason"
                                className="h-7 w-28 text-xs"
                              />
                            )}
                            {s === "pending" && (
                              <Button size="sm" variant="outline" onClick={() => hold.mutate(it.id)} disabled={hold.isPending}>Hold</Button>
                            )}
                            {s === "held" && (
                              <Button size="sm" variant="outline" onClick={() => release.mutate(it.id)} disabled={release.isPending}>Release</Button>
                            )}
                            {s === "failed" && (
                              <Button size="sm" variant="outline" onClick={() => retry.mutate(it.id)} disabled={retry.isPending}>Retry</Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => cancel.mutate(it.id)} disabled={cancel.isPending}>Cancel</Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
