/**
 * PackWaveLabelButton — reprint every sealed carton label on a wave.
 *
 * A single carton prints through the per-entity seam next to the carton
 * row, which is right for one carton. A 40-carton shipment is a batch:
 * a client loop over print() dies with the tab and leaves no ledger, so
 * this submits ONE `label_print_run` with a `pack_wave` selection and
 * lets the server expand it (ADR label engine). Cartons without a
 * licence plate code are refused server-side with a reason (ADR-0089).
 */
import { Printer, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useLabelRunActions } from "@/hooks/inventory/useLabelRuns";

interface Props {
  businessId: string | null;
  waveId: string;
  warehouseId?: string | null;
  /** Sealed cartons currently on the wave — used for the label and guard only. */
  sealedCount: number;
}

export function PackWaveLabelButton({ businessId, waveId, warehouseId, sealedCount }: Props) {
  const navigate = useNavigate();
  const { createRun } = useLabelRunActions(businessId);

  if (sealedCount < 2) return null;

  const submit = async () => {
    const runId = await createRun.mutateAsync({
      templateKey: "shipping_label",
      workflow: "shipping",
      entityType: "carton",
      selection: { kind: "pack_wave", wave_id: waveId, sealed_only: true },
      warehouseId: warehouseId ?? null,
      name: `Shipping labels · ${sealedCount} carton${sealedCount === 1 ? "" : "s"}`,
    });
    if (runId) navigate("/inventory/label-operations");
  };


  return (
    <Button size="sm" variant="outline" onClick={submit} disabled={createRun.isPending}>
      {createRun.isPending ? (
        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
      ) : (
        <Printer className="h-4 w-4 mr-1" />
      )}
      Label all {sealedCount}
    </Button>
  );
}
