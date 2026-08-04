/**
 * WaveDocumentsMenu — wave paperwork (ADR-0112 Phase 5), dispatched through
 * the single sanctioned client entry point (`printDocument`, ADR-0086).
 *
 * The tower REQUESTS documents; it never renders them and never picks a
 * transport. Policy resolution (ADR-0088) decides medium, printer and paper.
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

export type WaveDocumentType = "wave_pick_list" | "wave_summary";

const LABELS: Record<WaveDocumentType, string> = {
  wave_pick_list: "Wave pick list",
  wave_summary: "Wave summary",
};

interface Props {
  waveId: string;
  size?: "sm" | "default";
  variant?: "outline" | "default" | "ghost";
}

export function WaveDocumentsMenu({ waveId, size = "sm", variant = "ghost" }: Props) {
  const [busy, setBusy] = useState(false);
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const run = async (documentType: WaveDocumentType) => {
    setBusy(true);
    try {
      const result = await printDocument({
        documentType,
        documentId: waveId,
        intent: "a4_document",
        businessId: currentBusiness?.id ?? null,
        branchId: currentBranch?.id ?? null,
      });
      if (result.success) {
        toast.success(`${LABELS[documentType]} sent to the printer`);
      } else if (result.needsDevice) {
        toast.error("No printer is set up for warehouse paperwork yet");
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
          <Printer className="mr-1.5 h-3.5 w-3.5" /> Documents
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(Object.keys(LABELS) as WaveDocumentType[]).map((t) => (
          <DropdownMenuItem key={t} onSelect={() => void run(t)}>
            {LABELS[t]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default WaveDocumentsMenu;
