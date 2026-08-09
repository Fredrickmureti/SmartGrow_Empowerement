/**
 * ScanToDocumentButton — handheld-only list-page entry into the in-app
 * camera scanner.
 *
 * On a phone/tablet the device camera IS the scanner, so the operator
 * should be able to start scanning straight from the document register
 * without first opening the create form and hunting for the scan field.
 * This navigates to the document's create route with
 * `state.openScanSession`, which `<DocumentLineScanner openSessionOnMount>`
 * consumes to open the Scan Session sheet on mount.
 *
 * Renders nothing on desktop/workstation — there the paired-phone /
 * wedge transport and the workspace scan chip already cover the flow
 * (ADR 0107, ADR 0121).
 */
import { ScanLine } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useLocalScan } from "@/hooks/scanner/useLocalScan";
import { cn } from "@/lib/utils";

interface ScanToDocumentButtonProps {
  /** Create route for the document, e.g. `/sales/estimates/new`. */
  createPath: string;
  /** Button copy, e.g. "Scan to estimate". */
  label: string;
  className?: string;
  disabled?: boolean;
}

export function ScanToDocumentButton({
  createPath,
  label,
  className,
  disabled,
}: ScanToDocumentButtonProps) {
  const navigate = useNavigate();
  const { handheld } = useLocalScan();

  if (!handheld) return null;

  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      onClick={() => navigate(createPath, { state: { openScanSession: true } })}
      className={cn("flex-1 sm:flex-none", className)}
    >
      <ScanLine className="mr-2 h-4 w-4" />
      {label}
    </Button>
  );
}

export default ScanToDocumentButton;
