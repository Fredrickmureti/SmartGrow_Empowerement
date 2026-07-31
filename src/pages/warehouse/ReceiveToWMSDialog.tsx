/**
 * ReceiveToWMSDialog — Phase 2 loop entry point.
 *
 * Picks a recent `goods_receipts` row that hasn't been staged yet
 * (no `wms_tasks` exist referencing any of its line ids), picks a
 * staging bin in the receipt's warehouse, and calls
 * `receive_goods_to_wms(p_goods_receipt_id, p_staging_location_id)`
 * so LPNs + putaway tasks + suggestion audit rows are created in one
 * transaction. On success we surface the seeded task count and let
 * the caller navigate to the Putaway queue.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { replayGuardedCall } from "@/features/warehouse/scanning/replayGuardedCall";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useBusinesses } from "@/hooks/useBusinesses";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onStaged?: (result: { tasks_created: number; lpns_created: number; task_ids: string[] }) => void;
  /** When set, dialog is locked to this specific receipt (used from a GRN detail). */
  fixedGoodsReceiptId?: string;
}

export function ReceiveToWMSDialog({ open, onOpenChange, onStaged, fixedGoodsReceiptId }: Props) {
  const qc = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const [goodsReceiptId, setGoodsReceiptId] = useState<string>(fixedGoodsReceiptId ?? "");
  const [stagingId, setStagingId] = useState<string>("");

  useEffect(() => {
    if (fixedGoodsReceiptId) setGoodsReceiptId(fixedGoodsReceiptId);
  }, [fixedGoodsReceiptId]);

  useEffect(() => {
    if (!open) { setGoodsReceiptId(fixedGoodsReceiptId ?? ""); setStagingId(""); }
  }, [open, fixedGoodsReceiptId]);

  // Load recent receipts that have NOT been staged into the WMS yet.
  const { data: receipts, isLoading: recLoading } = useQuery({
    queryKey: ["wms-unstaged-receipts", currentBusiness?.id],
    enabled: !!currentBusiness?.id && open && !fixedGoodsReceiptId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("goods_receipts")
        .select("id, receipt_number, receipt_date, warehouse_id, status")
        .eq("business_id", currentBusiness!.id)
        .order("receipt_date", { ascending: false })
        .limit(30);
      if (error) throw error;
      const rows = data ?? [];
      // Filter out receipts whose lines already have a putaway task
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return rows;
      const { data: existing } = await supabase
        .from("wms_tasks")
        .select("source_doc_id")
        .eq("task_type", "putaway")
        .in("source_doc_id", ids);
      const staged = new Set((existing ?? []).map((x) => x.source_doc_id));
      return rows.filter((r) => !staged.has(r.id));
    },
  });

  const selectedReceipt = useMemo(() => {
    if (fixedGoodsReceiptId) return null;
    return (receipts ?? []).find((r) => r.id === goodsReceiptId) ?? null;
  }, [receipts, goodsReceiptId, fixedGoodsReceiptId]);

  // Resolve warehouse for the receipt (either from the dropdown row or fixed lookup)
  const { data: fixedReceipt } = useQuery({
    queryKey: ["wms-fixed-receipt", fixedGoodsReceiptId],
    enabled: !!fixedGoodsReceiptId && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("goods_receipts")
        .select("id, receipt_number, warehouse_id")
        .eq("id", fixedGoodsReceiptId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const warehouseId = selectedReceipt?.warehouse_id ?? fixedReceipt?.warehouse_id ?? null;

  const { data: stagingBins } = useQuery({
    queryKey: ["wms-staging-bins", warehouseId],
    enabled: !!warehouseId && open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id, code, name, is_receiving_staging, is_default")
        .eq("warehouse_id", warehouseId!)
        .eq("is_active", true)
        .order("is_receiving_staging", { ascending: false })
        .order("code");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Auto-pick default staging bin
  useEffect(() => {
    if (stagingId || !stagingBins) return;
    const preferred = stagingBins.find((b) => b.is_receiving_staging) ?? stagingBins.find((b) => b.is_default);
    if (preferred) setStagingId(preferred.id);
  }, [stagingBins, stagingId]);

  const stage = useMutation({
    mutationFn: async () => {
      if (!goodsReceiptId) throw new Error("Choose a goods receipt");
      if (!stagingId) throw new Error("Choose a staging bin");
      // Phase 5.1 — replay-guarded: staging the same receipt twice would
      // mint a second set of LPs and putaway tasks.
      const { data } = await replayGuardedCall<{
        tasks_created: number; lpns_created: number; task_ids: string[];
      }>("receive_goods_to_wms", {
        p_goods_receipt_id: goodsReceiptId,
        p_staging_location_id: stagingId,
      });
      return data;
    },
    onSuccess: (r) => {
      toast.success(`Staged ${r.lpns_created} plates · ${r.tasks_created} putaway tasks`);
      qc.invalidateQueries({ queryKey: ["wms-tasks"] });
      qc.invalidateQueries({ queryKey: ["wms-lpns"] });
      qc.invalidateQueries({ queryKey: ["wms-unstaged-receipts"] });
      onStaged?.(r);
      onOpenChange(false);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Staging failed"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Receive to warehouse</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {!fixedGoodsReceiptId && (
            <div>
              <Label>Goods receipt</Label>
              <Select value={goodsReceiptId} onValueChange={setGoodsReceiptId}>
                <SelectTrigger>
                  <SelectValue placeholder={recLoading ? "Loading…" : "Choose an unstaged receipt"} />
                </SelectTrigger>
                <SelectContent>
                  {(receipts ?? []).length === 0 && !recLoading ? (
                    <div className="p-2 text-sm text-muted-foreground">No unstaged receipts.</div>
                  ) : (
                    (receipts ?? []).map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.receipt_number} · {r.receipt_date}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {fixedGoodsReceiptId && fixedReceipt && (
            <div className="text-sm text-muted-foreground">
              Receipt <span className="font-mono">{fixedReceipt.receipt_number}</span>
            </div>
          )}

          <div>
            <Label>Staging bin</Label>
            <Select value={stagingId} onValueChange={setStagingId} disabled={!warehouseId}>
              <SelectTrigger>
                <SelectValue placeholder={warehouseId ? "Choose staging bin" : "Pick a receipt first"} />
              </SelectTrigger>
              <SelectContent>
                {(stagingBins ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.code} · {b.name}
                    {b.is_receiving_staging ? " (receiving)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              Flag bins with <span className="font-mono">is_receiving_staging</span> in the layout editor to see them at the top.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => stage.mutate()}
            disabled={stage.isPending || !goodsReceiptId || !stagingId}
          >
            {stage.isPending ? "Staging…" : "Stage & create tasks"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ReceiveToWMSDialog;
