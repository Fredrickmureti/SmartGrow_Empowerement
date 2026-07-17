/**
 * Mobile receive — pick a staging bin, tap Stage to WMS.
 * Wraps `receive_goods_to_wms` behind the offline queue.
 */
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";

interface Receipt {
  id: string;
  receipt_number: string;
  status: string;
  warehouse_id: string | null;
}

export default function MobileReceive() {
  const { id } = useParams();
  const nav = useNavigate();
  const [stagingId, setStagingId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const { data: receipt } = useQuery({
    queryKey: ["wm-receipt", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("goods_receipts")
        .select("id, receipt_number, status, warehouse_id")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Receipt | null;
    },
  });

  const { data: bins } = useQuery({
    queryKey: ["wm-staging-bins", receipt?.warehouse_id],
    enabled: !!receipt?.warehouse_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stock_locations")
        .select("id, code, name, is_receiving_staging, is_default")
        .eq("warehouse_id", receipt!.warehouse_id!)
        .eq("is_active", true)
        .order("is_receiving_staging", { ascending: false })
        .order("code");
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    if (stagingId || !bins) return;
    const pref =
      bins.find((b) => b.is_receiving_staging) ?? bins.find((b) => b.is_default);
    if (pref) setStagingId(pref.id);
  }, [bins, stagingId]);

  const submit = async () => {
    if (!receipt || !stagingId) return;
    setBusy(true);
    try {
      const r = await enqueue("receive_goods_to_wms", {
        p_goods_receipt_id: receipt.id,
        p_staging_location_id: stagingId,
      });
      toast.success(r.queued ? "Queued (offline)" : "Staged to WMS");
      nav("/wm");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <MobileWarehouseLayout
      title="Receive"
      back="/wm"
      bottomBar={
        <Button
          className="w-full h-12"
          size="lg"
          disabled={busy || !receipt || !stagingId}
          onClick={submit}
        >
          {busy ? "Working…" : "Stage to WMS"}
        </Button>
      }
    >
      <div className="space-y-4">
        {!receipt ? (
          <div>Loading…</div>
        ) : (
          <>
            <div className="rounded border p-3">
              <div className="text-xs text-muted-foreground">Goods receipt</div>
              <div className="font-mono font-medium">{receipt.receipt_number}</div>
              <div className="text-xs text-muted-foreground">{receipt.status}</div>
            </div>
            <div>
              <Label>Staging bin</Label>
              <Select value={stagingId} onValueChange={setStagingId}>
                <SelectTrigger className="h-12">
                  <SelectValue placeholder="Choose bin" />
                </SelectTrigger>
                <SelectContent>
                  {(bins ?? []).map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      <span className="font-mono">{b.code}</span> — {b.name}
                      {b.is_receiving_staging ? " (staging)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </div>
    </MobileWarehouseLayout>
  );
}
