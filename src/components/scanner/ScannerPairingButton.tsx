/**
 * ScannerPairingButton — opens the workspace-scoped phone-scanner pairing
 * dialog. This is a thin chip over `useWorkspaceScanner()` — the underlying
 * `scanner_session` and realtime channel are owned by
 * `ScannerWorkspaceProvider` (mounted in AuthenticatedShell), NOT by this
 * button. As a result:
 *
 *   - Clicking the button does not mint a new session if one already
 *     exists for the workspace; it just (re)opens the QR dialog.
 *   - Closing the dialog does NOT tear down the channel — the phone stays
 *     paired and continues to deliver scans to whatever <BarcodeInputField>
 *     is focused on any page in the app.
 *   - The connected-state chip reflects the SINGLE workspace device, so
 *     navigating between Products / Inventory / Goods Receipt / etc. all
 *     show the same "Phone paired" badge without re-pairing.
 *
 * Props are kept for source-compat with existing call sites; `businessId`
 * and `branchId` are now sourced from context and the props are ignored.
 */

import { Smartphone, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspaceScanner } from "@/contexts/ScannerWorkspaceContext";

interface Props {
  /** @deprecated sourced from BusinessContext */
  businessId?: string;
  /** @deprecated sourced from BranchContext */
  branchId?: string | null;
  /** Short human label shown in the dialog (and to the phone). */
  label: string;
  variant?: "default" | "outline" | "ghost";
  size?: "sm" | "default";
  className?: string;
  /**
   * @deprecated connection state is now sourced from the workspace
   * provider; the prop is ignored.
   */
  connected?: boolean;
}

export function ScannerPairingButton({
  businessId,
  label,
  variant = "outline",
  size = "sm",
  className,
}: Props) {
  const { isPaired, openPairing } = useWorkspaceScanner();
  // Stay invisible until the workspace has a business — pairing makes no
  // sense before then (matches previous behaviour of the button).
  if (!businessId) return null;
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={() => openPairing(label)}
      title={isPaired ? "Phone paired — scans flow to the focused field" : "Pair your phone as a scanner"}
    >
      {isPaired ? (
        <CheckCircle2 className="mr-2 h-4 w-4 text-emerald-500" />
      ) : (
        <Smartphone className="mr-2 h-4 w-4" />
      )}
      {isPaired ? "Phone paired" : "Pair phone scanner"}
    </Button>
  );
}
