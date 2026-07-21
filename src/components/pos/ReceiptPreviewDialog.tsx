/**
 * ReceiptPreviewDialog — Radix Dialog shell around the shared
 * `ReceiptPreviewBody`. Kept as a stable public API for surfaces that
 * legitimately need a page-level dialog:
 *
 *   - `POSReports` (admin reprint from a report row) — dialog is correct
 *     because it opens over a report page, not inside the workstation.
 *   - `POSTerminal` (transitional) — still consumes this shell until the
 *     Step-5 migration to `ReceiptPreviewSheet` lands; the ESLint rule
 *     `no-dialog-for-pos-workspace` fires only on files under
 *     `src/apps/pos/terminal/**`, so this location is compliant.
 *
 * All hardware/print/tabs logic lives in `ReceiptPreviewBody`.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ReceiptPreviewBody,
  type ReceiptPreviewTransaction,
} from "./ReceiptPreviewBody";

interface ReceiptPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: ReceiptPreviewTransaction | null;
  onPrint?: () => void;
  onEmail?: () => void;
  /**
   * Optional — when supplied, a "Clone" button appears next to Print and
   * fires this callback so the caller can re-open a POS session
   * pre-filled with the same line items. Enerpize-style flow.
   */
  onClone?: () => void;
}

export function ReceiptPreviewDialog({
  open,
  onOpenChange,
  transaction,
  onPrint,
  onEmail,
  onClone,
}: ReceiptPreviewDialogProps) {
  if (!transaction) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-2xl lg:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Transaction Complete</DialogTitle>
        </DialogHeader>
        <ReceiptPreviewBody
          transaction={transaction}
          onClose={() => onOpenChange(false)}
          onPrint={onPrint}
          onEmail={onEmail}
          onClone={onClone}
        />
      </DialogContent>
    </Dialog>
  );
}
