/**
 * CountDocumentsMenu — the four cycle-count A4 artifacts (ADR 0106),
 * dispatched through the single sanctioned client entry point
 * (`printDocument` from `@/services/printing/PrintService`, ADR-0086).
 *
 * A page never invokes a render endpoint directly, and never chooses a
 * transport: policy resolution (ADR-0088) decides medium, printer and
 * paper.
 *
 * Blind sessions offer `count_sheet_blind`, which is a DIFFERENT document
 * type backed by a different fetcher — not the same sheet with a flag —
 * so an expected quantity cannot leak onto an operator's paperwork by
 * misconfiguration.
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

export type CountDocumentType =
  | "count_sheet"
  | "count_sheet_blind"
  | "count_variance_report"
  | "count_audit_report";

const LABELS: Record<CountDocumentType, string> = {
  count_sheet: "Count sheet",
  count_sheet_blind: "Blind count sheet",
  count_variance_report: "Difference report",
  count_audit_report: "Audit report",
};

interface CountDocumentsMenuProps {
  sessionId: string;
  /** Blind sessions print the blind sheet; the standard sheet is withheld. */
  isBlind?: boolean;
  /** Restrict the menu — the counting screen has no use for the reports. */
  only?: CountDocumentType[];
  size?: "sm" | "default";
  variant?: "outline" | "default" | "ghost";
}

export function CountDocumentsMenu({
  sessionId,
  isBlind = false,
  only,
  size = "default",
  variant = "outline",
}: CountDocumentsMenuProps) {
  const [busy, setBusy] = useState(false);
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();

  const sheet: CountDocumentType = isBlind ? "count_sheet_blind" : "count_sheet";
  const available: CountDocumentType[] = (
    only ?? [sheet, "count_variance_report", "count_audit_report"]
  ).map((t) => (t === "count_sheet" || t === "count_sheet_blind" ? sheet : t));

  const run = async (documentType: CountDocumentType) => {
    setBusy(true);
    try {
      const result = await printDocument({
        documentType,
        documentId: sessionId,
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
          <Printer className="h-4 w-4 mr-2" /> Print
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

export default CountDocumentsMenu;
