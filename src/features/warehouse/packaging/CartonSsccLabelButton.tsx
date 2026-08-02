/**
 * CartonSsccLabelButton — the pack-station seam for GS1 handling-unit
 * identity (ADR 0105, Phase 4).
 *
 * Flow, all server-owned:
 *   1. Read the SSCC already bound to this carton (registry is read-only
 *      for clients).
 *   2. If none exists, `wms_sscc_allocate` mints one atomically from the
 *      business GS1 prefix — idempotent per carton, serials never recycled.
 *   3. Print the `wms.label.carton` template with the GS1-128 payload from
 *      `wms_sscc_label_payload`.
 *   4. Report the print into the SSCC event ledger. A REPRINT requires a
 *      reason, enforced server-side and collected here.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PrintLabelButton } from "@/components/labels/PrintLabelButton";
import { WMS_LABEL_KEY } from "@/features/warehouse/labels/wmsLabels";
import { Barcode } from "lucide-react";
import {
  allocateSscc,
  fetchSsccLabelPayload,
  markSsccPrinted,
} from "@/features/warehouse/packaging/cartonSscc";

interface Props {
  businessId: string;
  cartonId: string;
  packagingTypeId?: string | null;
  warehouseId?: string | null;
  packagingName?: string | null;
  orderNumber?: string | null;
  cartonSequence?: string | number | null;
  grossWeightKg?: number | null;
  warehouseName?: string | null;
  disabled?: boolean;
}

export function CartonSsccLabelButton({
  businessId,
  cartonId,
  packagingTypeId,
  warehouseId,
  packagingName,
  orderNumber,
  cartonSequence,
  grossWeightKg,
  warehouseName,
  disabled,
}: Props) {
  const qc = useQueryClient();
  const [reprint, setReprint] = useState<{ sscc: string } | null>(null);
  const [reason, setReason] = useState("");

  const registryKey = ["wms-sscc", cartonId];
  const { data: record } = useQuery({
    queryKey: registryKey,
    enabled: !!cartonId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_sscc_registry")
        .select("sscc, status, printed_count")
        .eq("entity_type", "carton")
        .eq("entity_id", cartonId)
        .eq("status", "assigned")
        .maybeSingle();
      if (error) throw error;
      return data as { sscc: string; status: string; printed_count: number } | null;
    },
  });

  const allocate = useMutation({
    mutationFn: () =>
      allocateSscc({
        businessId,
        entityType: "carton",
        entityId: cartonId,
        packagingTypeId,
        warehouseId,
      }),
    onSuccess: (r) => {
      toast.success(r.reused ? `SSCC ${r.sscc}` : `SSCC minted · ${r.sscc}`);
      qc.invalidateQueries({ queryKey: registryKey });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "SSCC allocation failed"),
  });

  const labelVars = async (sscc: string) => {
    const payload = await fetchSsccLabelPayload(businessId, sscc);
    return {
      barcode_data: payload.barcode_data,
      sscc_hri: payload.hri,
      sscc: payload.sscc,
      packaging_name: packagingName ?? payload.packaging?.name ?? "",
      order_number: orderNumber ?? "",
      carton_sequence: cartonSequence ?? "",
      gross_weight: grossWeightKg != null ? `${grossWeightKg} kg` : "",
      warehouse_name: warehouseName ?? "",
      printed_at: new Date().toLocaleString(),
    };
  };

  const [vars, setVars] = useState<Record<string, string | number> | null>(null);

  const prepare = useMutation({
    mutationFn: async (sscc: string) => labelVars(sscc),
    onSuccess: (v) => setVars(v),
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not build label payload"),
  });

  const audit = useMutation({
    mutationFn: (v: { sscc: string; isReprint: boolean; reason?: string }) =>
      markSsccPrinted({
        businessId,
        sscc: v.sscc,
        copies: 1,
        isReprint: v.isReprint,
        reason: v.reason ?? null,
        payload: { source: "pack_station", carton_id: cartonId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: registryKey }),
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Print audit failed"),
  });

  if (!record?.sscc) {
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || allocate.isPending}
        onClick={() => allocate.mutate()}
      >
        <Barcode className="h-4 w-4 mr-1" /> SSCC
      </Button>
    );
  }

  const alreadyPrinted = (record.printed_count ?? 0) > 0;

  return (
    <>
      <span className="font-mono text-[11px] text-muted-foreground">
        {record.sscc}
      </span>
      {vars ? (
        <PrintLabelButton
          label={alreadyPrinted ? "Reprint" : "Carton label"}
          size="sm"
          variant="outline"
          templateKey={WMS_LABEL_KEY.CARTON}
          workflow="shipping"
          product={{
            id: cartonId,
            name: `Handling unit ${record.sscc}`,
            sku: record.sscc,
            barcode: record.sscc,
          }}
          sourceDocType="wms_pack_carton"
          sourceDocId={cartonId}
          idempotencyKey={`carton_label:${record.sscc}:${record.printed_count ?? 0}`}
          extraVars={vars}
          disabled={disabled}
          onComplete={(r) => {
            if (!r.success) return;
            if (alreadyPrinted) setReprint({ sscc: record.sscc });
            else audit.mutate({ sscc: record.sscc, isReprint: false });
          }}
        />
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || prepare.isPending}
          onClick={() => prepare.mutate(record.sscc)}
        >
          <Barcode className="h-4 w-4 mr-1" />
          {alreadyPrinted ? "Reprint label" : "Carton label"}
        </Button>
      )}

      <Dialog
        open={!!reprint}
        onOpenChange={(open) => {
          if (!open) {
            setReprint(null);
            setReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reprint reason</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This handling unit label was already printed. GS1 audit requires a
            reason for every reprint.
          </p>
          <div>
            <Label htmlFor="reprint-reason">Reason</Label>
            <Input
              id="reprint-reason"
              value={reason}
              placeholder="Label damaged / printer jam / …"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReprint(null)}>
              Cancel
            </Button>
            <Button
              disabled={!reason.trim() || audit.isPending}
              onClick={() => {
                if (!reprint) return;
                audit.mutate(
                  { sscc: reprint.sscc, isReprint: true, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      setReprint(null);
                      setReason("");
                      toast.success("Reprint logged");
                    },
                  },
                );
              }}
            >
              Log reprint
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default CartonSsccLabelButton;
