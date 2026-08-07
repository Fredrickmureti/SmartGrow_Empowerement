import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useTransactionReversal,
  type ReversalIntent,
  type ReversalOperation,
} from "@/hooks/useTransactionReversal";
import { useCurrency } from "@/hooks/useCurrency";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  FileMinus,
  Loader2,
  Lock,
  RotateCcw,
  Undo2,
  Wallet,
} from "lucide-react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { ReversalConsequencePreview } from "@/components/reversal/ReversalConsequencePreview";
import { useReversalConsequences } from "@/components/reversal/useReversalConsequences";
import { ReversalReasonField } from "@/components/reversal/ReversalReasonField";
import {
  useReversalReasonCodes,
  isReversalReasonComplete,
} from "@/components/reversal/useReversalReasonCodes";


/**
 * Reversal intent step for a supplier bill (Phase 3 — AP parity).
 *
 * The AP mirror of `VoidInvoiceDialog`, deliberately built the same way: this
 * sheet decides nothing. `resolve_reversal_intent('bill', …)` decides, on the
 * server, from settlement / three-way-match / fiscal-period state, and
 * `preview_reversal_consequences` shows what the void will do before anyone
 * authorises it. Confirming calls `void_bill_atomic`, the single writer.
 *
 * Before this existed, voiding a bill was a bare dropdown item: no reason, no
 * confirmation, no view of the GL or match consequences — while the identical
 * action on the sales side demanded all three. Do not reintroduce a direct
 * `voidBill` call from a menu; every reversal enters through intent + preview.
 */
interface VoidBillDialogProps {
  bill: {
    id: string;
    bill_number: string;
    total: number;
    amount_paid: number;
    status: string;
    currency?: string;
    vendor_id?: string | null;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

const OPERATION_ICONS: Record<string, typeof Ban> = {
  void: Ban,
  credit_note: FileMinus,
  vendor_credit_note: FileMinus,
  goods_return: RotateCcw,
  refund: Wallet,
  reverse_payment: Undo2,
  none: Lock,
};

const BLOCKER_LABELS: Record<string, string> = {
  already_reversed: "Already voided",
  settled: "Settled by a supplier payment",
  billed: "Already billed",
  bank_reconciled: "Bank reconciled",
  period_closed: "Period closed",
};

export function VoidBillDialog({ bill, open, onOpenChange, onSuccess }: VoidBillDialogProps) {
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [intent, setIntent] = useState<ReversalIntent | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const { voidBill, resolveReversalIntent, unmatchBankLinesForReversal } =
    useTransactionReversal();
  const [isUnmatching, setIsUnmatching] = useState(false);
  const { formatCurrency } = useCurrency();
  const navigate = useNavigate();

  // One shared vocabulary (ADR 0129) — the same codes the writer validates.
  const { reasonCodes, isLoading: isLoadingReasons } = useReversalReasonCodes("bill", open);
  const reasonComplete = isReversalReasonComplete(reasonCodes, reasonCode, reason);

  // Resolved on open and re-resolved per bill — never cached across documents,
  // because payments and match state move underneath the sheet.
  useEffect(() => {
    if (!open || !bill) {
      setIntent(null);
      return;
    }
    let cancelled = false;
    setIsResolving(true);
    setReason("");
    setReasonCode("");

    resolveReversalIntent("bill", bill.id)
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
  }, [open, bill?.id]);

  const voidOption = intent?.operations.find((op) => op.operation === "void");
  const canVoid = Boolean(voidOption?.allowed);
  const alternatives = (intent?.operations ?? []).filter(
    (op) => op.operation !== "void" && op.operation !== "none" && op.allowed
  );

  const {
    consequences,
    isLoading: isPreviewLoading,
    isError: isPreviewError,
    refetch: refetchPreview,
  } = useReversalConsequences("bill", bill?.id, open && canVoid);

  // Phase 4 — same guided resolution as the AR side: un-match the supplier
  // payment's statement line, then re-resolve policy and preview.
  const handleUnmatchBankLines = async () => {
    if (!bill) return;
    setIsUnmatching(true);
    try {
      const ok = await unmatchBankLinesForReversal(
        "bill",
        bill.id,
        `Un-matched to void bill ${bill.bill_number ?? bill.id}`,
      );
      if (!ok) return;
      setIntent(await resolveReversalIntent("bill", bill.id));
      refetchPreview();
    } finally {
      setIsUnmatching(false);
    }
  };

  const handleVoid = async () => {
    if (!bill || !reasonComplete || !canVoid) return;
    setIsSubmitting(true);
    try {
      const success = await voidBill({
        billId: bill.id,
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

  const runOperation = (operation: ReversalOperation) => {
    if (!bill) return;
    switch (operation) {
      case "goods_return":
        onOpenChange(false);
        navigate(`/purchases/returns?action=create&contact_id=${bill.vendor_id ?? ""}`);
        break;
      case "refund":
      case "reverse_payment":
        onOpenChange(false);
        navigate("/purchases/payments");
        break;
      default:
        break;
    }
  };

  if (!bill) return null;

  const balance = bill.total - bill.amount_paid;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          Reverse Bill
        </span>
      }
      description={
        <>
          Bill <strong>{bill.bill_number}</strong>
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
            canVoid ? (
              <Button
                variant="destructive"
                onClick={handleVoid}
                disabled={isSubmitting || !reasonComplete || isPreviewLoading || isPreviewError}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Void Bill
              </Button>
            ) : null
          }
        />
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Bill total</span>
            <span className="font-medium">{formatCurrency(bill.total, bill.currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Paid</span>
            <span className="font-medium">{formatCurrency(bill.amount_paid, bill.currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Outstanding</span>
            <span className="font-medium">{formatCurrency(balance, bill.currency)}</span>
          </div>
        </div>

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
              We could not check what is legal for this bill. Close this panel and try again.
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

            {canVoid ? (
              <>
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <p className="font-medium">This cannot be undone.</p>
                    <p className="text-sm mt-1">
                      {voidOption?.description ??
                        "Voiding reverses the bill's postings, releases its purchase-order match and keeps the original as history."}
                    </p>
                  </AlertDescription>
                </Alert>

                <ReversalConsequencePreview
                  consequences={consequences}
                  isLoading={isPreviewLoading}
                  isError={isPreviewError}
                  currency={bill.currency}
                  onUnmatchBankLines={handleUnmatchBankLines}
                  isUnmatchingBankLines={isUnmatching}
                />

                <ReversalReasonField
                  documentType="bill"
                  idPrefix="bill-void"
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
                  <p className="font-medium">This bill cannot be voided.</p>
                  <p className="text-sm mt-1">
                    {voidOption?.blocked_reason ??
                      "The accounting state of this bill does not allow a void."}
                  </p>
                </AlertDescription>
              </Alert>
            )}

            {alternatives.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {canVoid ? "Other ways to correct this bill" : "What you can do instead"}
                </p>
                <div className="space-y-2">
                  {alternatives.map((option) => {
                    const Icon = OPERATION_ICONS[option.operation] ?? ArrowRight;
                    const isRecommended = intent.recommended === option.operation;
                    return (
                      <button
                        key={option.operation}
                        type="button"
                        onClick={() => runOperation(option.operation)}
                        className="w-full text-left rounded-lg border p-3 transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        <span className="flex items-start gap-3">
                          <Icon className="h-4 w-4 mt-0.5 shrink-0" />
                          <span className="flex-1">
                            <span className="flex items-center gap-2">
                              <span className="text-sm font-medium">{option.label}</span>
                              {isRecommended && (
                                <Badge variant="secondary" className="text-[10px]">
                                  Recommended
                                </Badge>
                              )}
                            </span>
                            {option.description && (
                              <span className="block text-xs text-muted-foreground mt-1">
                                {option.description}
                              </span>
                            )}
                          </span>
                          <ArrowRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </DetailSheet>
  );
}
