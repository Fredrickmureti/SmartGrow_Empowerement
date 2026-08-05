/**
 * Mobile QC — record checks and drive an inspection to a terminal state.
 * Counterpart to desktop `QCInspectionDetail.tsx`. RPCs go through
 * `enqueue()`:
 *
 *   record_qc_check
 *   accept_qc_inspection
 *   reject_qc_inspection
 *   cancel_qc_inspection
 *
 * The mobile screen collapses the desktop's rich free-form checks into
 * scan-friendly pass / hold / fail actions.
 */
import { useCallback, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { MobileWarehouseLayout } from "@/apps/warehouse-mobile/MobileWarehouseLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { enqueue } from "@/apps/warehouse-mobile/offlineQueue";
import { ProductScanField } from "@/features/warehouse/scanning/ProductScanField";
import type { GatedScan } from "@/features/warehouse/scanning/useWmsIdentityGate";
import { Check, X, Pause } from "lucide-react";

interface Inspection {
  id: string;
  state: string;
  business_id: string;
  branch_id: string | null;
  product_id: string | null;
  quantity: number;
  accepted_qty: number;
  rejected_qty: number;
  disposition: string | null;
  lot_number: string | null;
  notes: string | null;
  product: { sku: string | null; name: string | null } | null;
}

export default function MobileQC() {
  const { taskId } = useParams<{ taskId: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [passQty, setPassQty] = useState("");
  const [failQty, setFailQty] = useState("");
  const [notes, setNotes] = useState("");
  // Phase 3 — an inspector must prove they are holding the inspected item
  // before a verdict is posted. Same identity gate as receiving and picking.
  const [verified, setVerified] = useState(false);

  const { data: insp, isLoading } = useQuery({
    queryKey: ["wm-qc-inspection", taskId],
    enabled: !!taskId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_qc_inspections")
        .select("id, state, business_id, branch_id, product_id, quantity, accepted_qty, rejected_qty, disposition, lot_number, notes, product:product_id(sku, name)")
        .eq("id", taskId!)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Inspection | null;
    },
  });

  const onScanned = useCallback((scan: GatedScan | null) => setVerified(Boolean(scan)), []);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["wm-qc-inspection", taskId] });

  const accept = async () => {
    if (!insp || busy) return;
    const qty = Number(passQty || insp.quantity - insp.accepted_qty - insp.rejected_qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Enter a pass quantity");
      return;
    }
    setBusy(true);
    try {
      const r = await enqueue("accept_qc_inspection", {
        p_inspection_id: insp.id,
        p_accepted_qty: qty,
        p_notes: notes || null,
      });
      toast.success(r.queued ? "Queued (offline)" : "Passed");
      invalidate();
      if (!r.queued) nav("/wm");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Accept failed");
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!insp || busy) return;
    const qty = Number(failQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("Enter a fail quantity");
      return;
    }
    setBusy(true);
    try {
      const r = await enqueue("reject_qc_inspection", {
        p_inspection_id: insp.id,
        p_rejected_qty: qty,
        p_disposition: "return_to_vendor",
        p_notes: notes || null,
      });
      toast.success(r.queued ? "Queued (offline)" : "Failed");
      invalidate();
      if (!r.queued) nav("/wm");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setBusy(false);
    }
  };

  const hold = async () => {
    if (!insp || busy) return;
    setBusy(true);
    try {
      const r = await enqueue("cancel_qc_inspection", {
        p_inspection_id: insp.id,
        p_reason: notes || "held on floor",
      });
      toast.success(r.queued ? "Queued (offline)" : "On hold");
      invalidate();
      if (!r.queued) nav("/wm");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Hold failed");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading)
    return <MobileWarehouseLayout title="QC" back="/wm">Loading…</MobileWarehouseLayout>;
  if (!insp)
    return <MobileWarehouseLayout title="QC" back="/wm">Inspection not found.</MobileWarehouseLayout>;

  const terminal = ["accepted", "partially_accepted", "rejected", "cancelled"].includes(insp.state);
  const remaining = insp.quantity - insp.accepted_qty - insp.rejected_qty;

  return (
    <MobileWarehouseLayout title="QC" back="/wm" scanLabel="Scan the item under inspection">

      <div className="space-y-4">
        <div className="rounded border p-3">
          <div className="text-xs text-muted-foreground">Product</div>
          <div className="font-medium">{insp.product?.name ?? "—"}</div>
          <div className="font-mono text-xs">{insp.product?.sku}</div>
          {insp.lot_number && (
            <div className="text-xs mt-1">Lot: <span className="font-mono">{insp.lot_number}</span></div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded border p-2">
            <div className="text-xs text-muted-foreground">Qty</div>
            <div className="font-mono">{insp.quantity}</div>
          </div>
          <div className="rounded border p-2">
            <div className="text-xs text-muted-foreground">Pass</div>
            <div className="font-mono text-primary">{insp.accepted_qty}</div>
          </div>
          <div className="rounded border p-2">
            <div className="text-xs text-muted-foreground">Fail</div>
            <div className="font-mono text-destructive">{insp.rejected_qty}</div>
          </div>
        </div>

        <div className="rounded border p-3 text-sm">
          State: <span className="font-medium">{insp.state}</span>
          {!terminal && <span className="text-muted-foreground"> · remaining {remaining}</span>}
        </div>

        {!terminal && (
          <>
            <ProductScanField
              label="Scan the item"
              intent="qc.item"
              businessId={insp.business_id}
              branchId={insp.branch_id}
              expectedProductId={insp.product_id}
              expectedSku={insp.product?.sku}
              onResolved={onScanned}
            />
            {!verified && (
              <p className="text-xs text-muted-foreground">
                Scan the inspected item to unlock the verdict.
              </p>
            )}
            <div>
              <Label>Pass qty</Label>
              <Input
                inputMode="decimal"
                value={passQty}
                onChange={(e) => setPassQty(e.target.value)}
                placeholder={String(remaining)}
                className="h-12 text-lg font-mono"
              />
            </div>
            <div>
              <Label>Fail qty</Label>
              <Input
                inputMode="decimal"
                value={failQty}
                onChange={(e) => setFailQty(e.target.value)}
                placeholder="0"
                className="h-12 text-lg font-mono"
              />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="outline"
                className="h-14"
                disabled={busy || !verified}
                onClick={hold}
              >
                <Pause className="h-4 w-4 mr-1" /> Hold
              </Button>
              <Button
                variant="destructive"
                className="h-14"
                disabled={busy || !verified}
                onClick={reject}
              >
                <X className="h-4 w-4 mr-1" /> Fail
              </Button>
              <Button className="h-14" disabled={busy || !verified} onClick={accept}>
                <Check className="h-4 w-4 mr-1" /> Pass
              </Button>
            </div>
          </>
        )}
      </div>
    </MobileWarehouseLayout>
  );
}
