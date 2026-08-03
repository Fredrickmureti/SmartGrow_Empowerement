/**
 * DispatchDocumentsMenu — the four dispatch artifacts (ADR 0110),
 * dispatched through the single sanctioned client entry point
 * (`printDocument` from `@/services/printing/PrintService`, ADR-0086).
 *
 * Dispatch REQUESTS documents; it never renders them and never chooses a
 * transport. Policy resolution (ADR-0088) decides medium, printer and
 * paper — which is why the carrier label (a 4x6 thermal artifact) and the
 * bill of lading (A4) are requested with different intents.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { printDocument } from "@/services/printing/PrintService";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";

export type DispatchDocumentType =
  | "bill_of_lading"
  | "dispatch_manifest"
  | "packing_list"
  | "carrier_label";

const LABELS: Record<DispatchDocumentType, string> = {
  bill_of_lading: "Bill of lading",
  dispatch_manifest: "Dispatch manifest",
  packing_list: "Packing list",
  carrier_label: "Carrier label",
};

/** The label is a thermal artifact; the rest are A4 paperwork. */
const INTENTS: Record<DispatchDocumentType, "a4_document" | "label"> = {
  bill_of_lading: "a4_document",
  dispatch_manifest: "a4_document",
  packing_list: "a4_document",
  carrier_label: "label",
};

interface Props {
  manifestId: string;
  /** Own-fleet loads have no carrier label to print. */
  hideLabel?: boolean;
  size?: "sm" | "default";
  variant?: "outline" | "default" | "ghost";
}

export function DispatchDocumentsMenu({
  manifestId,
  hideLabel = false,
  size = "default",
  variant = "outline",
}: Props) {
  const [busy, setBusy] = useState(false);
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const available: DispatchDocumentType[] = (
    ["bill_of_lading", "dispatch_manifest", "packing_list", "carrier_label"] as const
  ).filter((t) => !(hideLabel && t === "carrier_label"));

  const run = async (documentType: DispatchDocumentType) => {
    setBusy(true);
    try {
      const result = await printDocument({
        documentType,
        documentId: manifestId,
        intent: INTENTS[documentType],
        businessId: currentBusiness?.id ?? null,
        branchId: currentBranch?.id ?? null,
      });
      if (result.success) {
        toast.success(`${LABELS[documentType]} sent to the printer`);
      } else if (result.needsDevice) {
        toast.error("No printer is set up for dispatch paperwork yet");
      } else {
        toast.error(`${LABELS[documentType]} could not be printed`);
      }
    } catch {
      toast.error(`${LABELS[documentType]} could not be printed`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} disabled={busy}>
          <Printer className="h-4 w-4 mr-2" /> Documents
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {available.map((t) => (
          <DropdownMenuItem key={t} onSelect={() => void run(t)}>
            {LABELS[t]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default DispatchDocumentsMenu;
