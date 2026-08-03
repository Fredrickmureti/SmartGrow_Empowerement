/**
 * LabourRosterButton — the published shift roster on paper (WLM Phase I).
 *
 * Dispatched through the single sanctioned client entry point
 * (`printDocument`, ADR-0086): the page states the document type and the
 * subject (a warehouse), and policy resolution (ADR-0088) decides medium,
 * printer and paper. The roster is a read model over `wms_operator_shifts` —
 * printing never publishes or changes a shift.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { printDocument } from "@/services/printing/PrintService";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";

interface Props {
  /** A single warehouse id — the roster is always warehouse-scoped. */
  warehouseId?: string;
  size?: "sm" | "icon" | "default";
  variant?: "outline" | "ghost" | "default";
}

export function LabourRosterButton({
  warehouseId,
  size = "default",
  variant = "outline",
}: Props) {
  const [busy, setBusy] = useState(false);
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const run = async () => {
    if (!warehouseId) return;
    setBusy(true);
    try {
      const result = await printDocument({
        documentType: "labour_roster",
        documentId: warehouseId,
        intent: "a4_document",
        businessId: currentBusiness?.id ?? null,
        branchId: currentBranch?.id ?? null,
      });
      if (result.success) toast.success("Roster sent to the printer");
      else if (result.needsDevice)
        toast.error("No printer is set up for warehouse paperwork yet");
      else toast.error("Roster could not be printed");
    } catch {
      toast.error("Roster could not be printed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      size={size}
      variant={variant}
      disabled={busy || !warehouseId}
      onClick={() => void run()}
      title={warehouseId ? "Print roster" : "Select a single warehouse to print its roster"}
    >
      <Printer className="h-4 w-4 mr-2" /> Print roster
    </Button>
  );
}

export default LabourRosterButton;
