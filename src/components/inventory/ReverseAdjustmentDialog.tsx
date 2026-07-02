/**
 * Wave 2 / Gap #1 — UI affordance for `reverse_stock_adjustment_atomic`.
 *
 * The RPC creates a mirror adjustment (negated quantities, same costs) and
 * posts the inverse journal entry atomically. The original is marked
 * `reversed` and linked via `reversed_by_adjustment_id`.
 *
 * Required reason (min 5 chars) so the audit trail records *why*.
 */
import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { StockAdjustment } from "@/hooks/useInventory";

interface ReverseAdjustmentDialogProps {
  adjustment: StockAdjustment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => Promise<void> | void;
  isPending: boolean;
}

const MIN_REASON_LEN = 5;

export function ReverseAdjustmentDialog({
  adjustment,
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: ReverseAdjustmentDialogProps) {
  const [reason, setReason] = useState("");

  const reasonOk = reason.trim().length >= MIN_REASON_LEN;
  const lineCount = adjustment?.items?.length ?? 0;
  const netQty = (adjustment?.items ?? []).reduce(
    (s, i) => s + (Number(i.quantity_adjustment) || 0),
    0,
  );

  const handleClose = (next: boolean) => {
    if (!next) setReason("");
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    if (!reasonOk || !adjustment) return;
    await onConfirm(reason.trim());
    setReason("");
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={handleClose}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <RotateCcw className="h-4 w-4" />
          Reverse stock adjustment
        </span>
      }
      description="Creates a mirror adjustment with negated quantities and posts an inverse journal entry. Both the original and the reversal remain on the audit trail. This action cannot be undone."
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => handleClose(false)} disabled={isPending}>
              Cancel
            </Button>
          }
          trailing={
            <Button
              variant="destructive"
              onClick={handleSubmit}
              disabled={!reasonOk || isPending || !adjustment}
            >
              {isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              Reverse adjustment
            </Button>
          }
        />
      }
    >
      {adjustment && (
        <div className="space-y-3 text-sm">
          <div className="rounded-md border bg-muted/30 p-3 space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Number</span>
              <span className="font-medium">{adjustment.adjustment_number}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Original reason</span>
              <span>{adjustment.reason}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Lines</span>
              <span>{lineCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Net qty change</span>
              <span className={netQty < 0 ? "text-green-700" : "text-red-700"}>
                {netQty > 0 ? "+" : ""}
                {netQty} → {-netQty} on reversal
              </span>
            </div>
          </div>

          <Alert>
            <AlertDescription className="text-xs">
              The reversal posts at <strong>today&apos;s</strong> resolved cost
              per product. If costs have moved since the original was approved,
              the mirror JE may not net to exactly zero against the original —
              that delta is a legitimate revaluation.
            </AlertDescription>
          </Alert>

          <div className="space-y-1">
            <Label htmlFor="reversal-reason">
              Reason for reversal <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="reversal-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Counted the wrong shelf; original adjustment was made in error."
              rows={3}
              disabled={isPending}
            />
            <p className="text-xs text-muted-foreground">
              Minimum {MIN_REASON_LEN} characters. Recorded on the audit trail.
            </p>
          </div>
        </div>
      )}
    </DetailSheet>

  );
}
