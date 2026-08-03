/**
 * LabourWorksheetButton — the operator's work list on paper (WLM Phase F).
 *
 * Dispatched through the single sanctioned client entry point
 * (`printDocument`, ADR-0086): the page states the document type and the
 * subject, and policy resolution (ADR-0088) decides medium, printer and
 * paper. The worksheet is a read model over `wms_tasks` + the utilisation
 * view — printing never assigns work.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { printDocument } from "@/services/printing/PrintService";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";

interface Props {
  operatorId: string;
  size?: "sm" | "icon" | "default";
  variant?: "outline" | "ghost" | "default";
}

export function LabourWorksheetButton({ operatorId, size = "icon", variant = "ghost" }: Props) {
  const [busy, setBusy] = useState(false);
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const run = async () => {
    setBusy(true);
    try {
      const result = await printDocument({
        documentType: "labour_worksheet",
        documentId: operatorId,
        intent: "a4_document",
        businessId: currentBusiness?.id ?? null,
        branchId: currentBranch?.id ?? null,
      });
      if (result.success) toast.success("Worksheet sent to the printer");
      else if (result.needsDevice) toast.error("No printer is set up for warehouse paperwork yet");
      else toast.error("Worksheet could not be printed");
    } catch {
      toast.error("Worksheet could not be printed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size={size} variant={variant} disabled={busy} onClick={() => void run()} title="Print worksheet">
      <Printer className="h-4 w-4" />
    </Button>
  );
}

export default LabourWorksheetButton;
