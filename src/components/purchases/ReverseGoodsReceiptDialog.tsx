/**
 * ReverseGoodsReceiptDialog — Phase 4b operator surface for the `goods_return`
 * operation on a posted goods receipt (ADR 0128).
 *
 * Built as the exact sibling of `VoidBillDialog` / `VoidInvoiceDialog`: this
 * sheet decides nothing. `resolve_reversal_intent('goods_receipt', …)` decides
 * on the server from billing / period / already-reversed state, and
 * `preview_reversal_consequences` shows the GL, stock and warehouse
 * consequences before anyone authorises them. Confirming calls
 * `void_goods_receipt_atomic`, the single writer.
 *
 * Do not add a direct `reverseGoodsReceipt` call from a menu item: reversal is
 * only ever entered through intent + preview, so the rules cannot drift between
 * call sites.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { ReversalConsequencePreview } from "@/components/reversal/ReversalConsequencePreview";
import { useReversalConsequences } from "@/components/reversal/useReversalConsequences";
import {
  useTransactionReversal,
  type ReversalIntent,
} from "@/hooks/useTransactionReversal";
import { AlertTriangle, Loader2, Lock } from "lucide-react";

interface ReverseGoodsReceiptDialogProps {
  receipt: {
    id: string;
    receipt_number: string;
    status?: string | null;
    currency?: string;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

const BLOCKER_LABELS: Record<string, string> = {
  already_reversed: "Already reversed",
  billed: "Already billed by a supplier bill",
  not_posted: "Never posted",
  period_closed: "Period closed",
  bank_reconciled: "Bank reconciled",
};

export function ReverseGoodsReceiptDialog({
  receipt,
  open,
  onOpenChange,
  onSuccess,
}: ReverseGoodsReceiptDialogProps) {
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [intent, setIntent] = useState<ReversalIntent | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [isUnmatching, setIsUnmatching] = useState(false);
  const { reverseGoodsReceipt, resolveReversalIntent, unmatchBankLinesForReversal } =
    useTransactionReversal();

  // Re-resolved per receipt on open: billing and period state move underneath a
  // long-lived sheet, so a cached verdict would authorise the wrong thing.
  useEffect(() => {
    if (!open || !receipt) {
      setIntent(null);
      return;
    }
    let cancelled = false;
    setIsResolving(true);
    setReason("");
    resolveReversalIntent("goods_receipt", receipt.id)
      .then((result) => {
        if (!cancelled) setIntent(result);
      })
      .finally(() => {
        if (!cancelled) setIsResolving(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, receipt?.id]);

  const returnOption = intent?.operations.find((op) => op.operation === "goods_return");
  const canReverse = Boolean(returnOption?.allowed);

  const {
    consequences,
    isLoading: isPreviewLoading,
    isError: isPreviewError,
    refetch: refetchPreview,
  } = useReversalConsequences("goods_receipt", receipt?.id, open && canReverse);

  const handleUnmatchBankLines = async () => {
    if (!receipt) return;
    setIsUnmatching(true);
    try {
      const ok = await unmatchBankLinesForReversal(
        "goods_receipt",
        receipt.id,
        `Un-matched to reverse goods receipt ${receipt.receipt_number ?? receipt.id}`,
      );
      if (!ok) return;
      setIntent(await resolveReversalIntent("goods_receipt", receipt.id));
      refetchPreview();
    } finally {
      setIsUnmatching(false);
    }
  };

  const handleReverse = async () => {
    if (!receipt || !reasonComplete || !canReverse) return;
    setIsSubmitting(true);
    try {
      const success = await reverseGoodsReceipt({
        goodsReceiptId: receipt.id,
        reason: reason.trim(),
        reasonCode,
      });
      if (success) {
        setReason("");
        setReasonCode("");
        onOpenChange(false);
        onSuccess?.();
      }

    } finally {
      setIsSubmitting(false);
    }
  };

  if (!receipt) return null;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          Return Received Goods
        </span>
      }
      description={
        <>
          Goods receipt <strong>{receipt.receipt_number}</strong>
        </>
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Close
            </Button>
          }
          trailing={
            canReverse ? (
              <Button
                variant="destructive"
                onClick={handleReverse}
                disabled={isSubmitting || !reasonComplete || isPreviewLoading || isPreviewError}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Reverse Receipt
              </Button>
            ) : null
          }
        />
      }
    >
      <div className="space-y-4">
        {isResolving && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {!isResolving && !intent && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              We could not check what is legal for this receipt. Close this panel and try again.
            </AlertDescription>
          </Alert>
        )}

        {!isResolving && intent && (
          <>
            {intent.blockers.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {intent.blockers.map((blocker) => (
                  <Badge key={blocker} variant="outline">
                    {BLOCKER_LABELS[blocker] ?? blocker}
                  </Badge>
                ))}
              </div>
            )}

            {canReverse ? (
              <>
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <p className="font-medium">This cannot be undone.</p>
                    <p className="text-sm mt-1">
                      {returnOption?.description ??
                        "Reversing takes the received quantities back out of stock, restores the purchase order and reverses the receipt posting. The receipt stays as history."}
                    </p>
                  </AlertDescription>
                </Alert>

                <ReversalConsequencePreview
                  consequences={consequences}
                  isLoading={isPreviewLoading}
                  isError={isPreviewError}
                  currency={receipt.currency}
                  onUnmatchBankLines={handleUnmatchBankLines}
                  isUnmatchingBankLines={isUnmatching}
                />

                <ReversalReasonField
                  documentType="goods_receipt"
                  idPrefix="gr-reverse"
                  code={reasonCode}
                  comment={reason}
                  onCodeChange={setReasonCode}
                  onCommentChange={setReason}
                  reasonCodes={reasonCodes}
                  isLoading={isLoadingReasons}
                  disabled={isSubmitting}
                />

              </>
            ) : (
              <Alert>
                <Lock className="h-4 w-4" />
                <AlertDescription>
                  <p className="font-medium">This receipt cannot be reversed.</p>
                  <p className="text-sm mt-1">
                    {returnOption?.blocked_reason ??
                      "The accounting state of this receipt does not allow a reversal."}
                  </p>
                </AlertDescription>
              </Alert>
            )}
          </>
        )}
      </div>
    </DetailSheet>
  );
}
