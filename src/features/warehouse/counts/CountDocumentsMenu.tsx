/**
 * CountDocumentsMenu — the four cycle-count A4 artifacts (ADR 0106).
 *
 * Preview, Print and Download are three different verbs and this menu
 * keeps them apart, exactly as the rest of the platform does:
 *
 *   • Preview  — render-only, on screen, no ledger row, no paper.
 *   • Print    — policy-driven dispatch (ADR-0086 / ADR-0088). The page
 *                never picks a transport, a printer or a paper size.
 *   • Download — the SAME frozen snapshot the printed copy is drawn from,
 *                handed to the browser. Never a print job.
 *
 * All three converge on one snapshot builder registered in
 * `resolveSourceDocumentRecord`, so a previewed, printed and downloaded
 * count sheet are byte-identical projections of one frozen record.
 *
 * Blind sessions offer `count_sheet_blind`, a DIFFERENT document type with
 * its own kind, template and snapshot builder — not the same sheet with a
 * flag — so an expected quantity cannot leak onto an operator's paperwork
 * by misconfiguration.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Printer, Eye, Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { printDocument } from "@/services/printing/PrintService";
import { downloadExport } from "@/services/exports/documentExport";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
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

/** Plain-English purpose, so an operator picks the right paper first time. */
const DESCRIPTIONS: Record<CountDocumentType, string> = {
  count_sheet: "Walk the aisle with expected quantities shown",
  count_sheet_blind: "Walk the aisle with nothing to copy from",
  count_variance_report: "What disagreed, by how much, and why",
  count_audit_report: "Every attempt, including recounts",
};

interface CountDocumentsMenuProps {
  sessionId: string;
  /** Business number of the count, used to name downloaded files. */
  countNumber?: string | null;
  /** Blind sessions print the blind sheet; the standard sheet is withheld. */
  isBlind?: boolean;
  /** Restrict the menu — the counting screen has no use for the reports. */
  only?: CountDocumentType[];
  size?: "sm" | "default";
  variant?: "outline" | "default" | "ghost";
}

export function CountDocumentsMenu({
  sessionId,
  countNumber,
  isBlind = false,
  only,
  size = "default",
  variant = "outline",
}: CountDocumentsMenuProps) {
  const [busy, setBusy] = useState(false);
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { preview } = useDocumentPreview();

  const sheet: CountDocumentType = isBlind ? "count_sheet_blind" : "count_sheet";
  const available: CountDocumentType[] = (
    only ?? [sheet, "count_variance_report", "count_audit_report"]
  ).map((t) => (t === "count_sheet" || t === "count_sheet_blind" ? sheet : t));

  const fileBase = (documentType: CountDocumentType) =>
    `${countNumber?.trim() || "count"}-${documentType}`;

  const runPrint = async (documentType: CountDocumentType) => {
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
        toast.error(`${LABELS[documentType]} could not be printed`, {
          description: result.error ?? undefined,
        });
      }
    } catch (err) {
      toast.error(`${LABELS[documentType]} could not be printed`, {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const runDownload = async (documentType: CountDocumentType) => {
    setBusy(true);
    try {
      const result = await downloadExport({
        documentType,
        documentId: sessionId,
        format: "pdf",
        filename: fileBase(documentType),
      });
      if (!result.success) {
        toast.error(`${LABELS[documentType]} could not be downloaded`, {
          description: result.error ?? undefined,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const runPreview = (documentType: CountDocumentType) => {
    preview({
      documentType,
      documentId: sessionId,
      title: `${LABELS[documentType]}${countNumber ? ` · ${countNumber}` : ""}`,
      filename: fileBase(documentType),
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} disabled={busy}>
          <FileText className="h-4 w-4 mr-2" /> Documents
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Warehouse documents</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {available.map((t) => (
          <DropdownMenuSub key={t}>
            <DropdownMenuSubTrigger>
              <div className="flex flex-col">
                <span>{LABELS[t]}</span>
                <span className="text-xs text-muted-foreground">{DESCRIPTIONS[t]}</span>
              </div>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => runPreview(t)}>
                <Eye className="h-4 w-4 mr-2" /> Preview on screen
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runPrint(t)}>
                <Printer className="h-4 w-4 mr-2" /> Print
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runDownload(t)}>
                <Download className="h-4 w-4 mr-2" /> Download PDF
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default CountDocumentsMenu;
