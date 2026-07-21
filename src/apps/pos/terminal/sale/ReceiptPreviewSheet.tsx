/**
 * ReceiptPreviewSheet — Sheet-shell wrapper around the shared
 * `ReceiptPreviewBody`, used by the SaleWorkspace for pro-forma
 * ("Print Bill") previews. Replaces the legacy `ReceiptPreviewDialog`
 * mount inside `POSTerminal.tsx` so pro-forma preview is a sheet on the
 * sale workspace rather than a page dialog — per the sheets-vs-
 * workspaces rule (`docs/architecture/POS_WORKSTATION_STATES.md`).
 *
 * Post-payment receipt display is owned by `ReceiptWorkspace`, not this
 * sheet — the sheet is strictly for pre-tender bill previews.
 */
import { SheetShell } from "../SheetShell";
import { useTerminalContext } from "../TerminalStateContext";
import {
  ReceiptPreviewBody,
  type ReceiptPreviewTransaction,
} from "@/components/pos/ReceiptPreviewBody";

interface ReceiptPreviewSheetProps {
  transaction: ReceiptPreviewTransaction | null;
  onEmail?: () => void;
}

export function ReceiptPreviewSheet({ transaction, onEmail }: ReceiptPreviewSheetProps) {
  const { closeSheet } = useTerminalContext();
  if (!transaction) return null;
  return (
    <SheetShell sheet="sale.receiptPreview" title="Print Bill">
      <ReceiptPreviewBody
        transaction={transaction}
        onClose={closeSheet}
        onEmail={onEmail}
      />
    </SheetShell>
  );
}
