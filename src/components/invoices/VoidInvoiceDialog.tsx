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
  Undo2,
  Wallet,
} from "lucide-react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { ReversalConsequencePreview } from "@/components/reversal/ReversalConsequencePreview";
import { useReversalConsequences } from "@/components/reversal/useReversalConsequences";


/**
 * Reversal intent step for a sales invoice (Phase 1 reversal intent policy).
 *
 * This sheet does NOT decide whether a void is legal. `resolve_reversal_intent`
 * does, on the server, from settlement / bank-reconciliation / fiscal-period
 * state. The sheet renders the resolved decision and only offers buttons for
 * operations the policy marked allowed.
 *
 * Why it works this way: the previous version offered a "Create Credit Note for
 * Refund" checkbox that actually sent `_cascade_payments`, silently voiding the
 * customer's payments and then raising a credit note for the same amount —
 * compensating the customer twice. No mature ERP unwinds a customer payment as a
 * side effect of voiding an invoice; a settled invoice is corrected with a
 * credit note, a refund, or an explicit payment reversal.
 */
interface VoidInvoiceDialogProps {
  invoice: {
    id: string;
    invoice_number: string;
    total: number;
    amount_paid: number;
    status: string;
    currency?: string;
    contact_id?: string | null;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /**
   * Opens the invoice's payment history, where ReversePaymentWizard owns the
   * refund / re-apply / void intents for the settling payment (ADR 0012).
   */
  onReversePayment?: () => void;
}

const OPERATION_ICONS: Record<ReversalOperation, typeof Ban> = {
  void: Ban,
  credit_note: FileMinus,
  vendor_credit_note: FileMinus,
  goods_return: Undo2,
  refund: Wallet,
  customer_credit: Wallet,
  reverse_payment: Undo2,
  none: Lock,
};

const BLOCKER_LABELS: Record<string, string> = {
  already_reversed: "Already reversed",
  settled: "Settled by a payment",
  bank_reconciled: "Bank reconciled",
  period_closed: "Period closed",
};

export function VoidInvoiceDialog({
  invoice,
  open,
  onOpenChange,
  onSuccess,
  onReversePayment,
}: VoidInvoiceDialogProps) {
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [intent, setIntent] = useState<ReversalIntent | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const { voidInvoice, resolveReversalIntent } = useTransactionReversal();
  const { formatCurrency } = useCurrency();
  const navigate = useNavigate();

  // Policy is resolved on open, and re-resolved for a different invoice —
  // never cached across documents, since settlement state changes underneath.
  useEffect(() => {
    if (!open || !invoice) {
      setIntent(null);
      return;
    }
    let cancelled = false;
    setIsResolving(true);
    setReason("");
    resolveReversalIntent("invoice", invoice.id)
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
  }, [open, invoice?.id]);

  const voidOption = intent?.operations.find((op) => op.operation === "void");
  const canVoid = Boolean(voidOption?.allowed);
  const alternatives = (intent?.operations ?? []).filter(
    (op) => op.operation !== "void" && op.operation !== "none" && op.allowed
  );

  // Phase 2 — nobody authorises a reversal blind. The preview is fetched for the
  // same document the intent was resolved for, and the confirm button stays
  // disabled until it has landed successfully.
  const {
    consequences,
    isLoading: isPreviewLoading,
    isError: isPreviewError,
  } = useReversalConsequences("invoice", invoice?.id, open && canVoid);


  const handleVoid = async () => {
    if (!invoice || !reason.trim() || !canVoid) return;

    setIsSubmitting(true);
    try {
      const success = await voidInvoice({
        invoiceId: invoice.id,
        reason: reason.trim(),
      });

      if (success) {
        setReason("");
        onOpenChange(false);
        onSuccess?.();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const runOperation = (operation: ReversalOperation) => {
    if (!invoice) return;
    switch (operation) {
      case "credit_note": {
        const params = new URLSearchParams({ invoice_id: invoice.id });
        if (invoice.contact_id) params.set("contact_id", invoice.contact_id);
        onOpenChange(false);
        navigate(`/sales/credit-notes/new?${params.toString()}`);
        break;
      }
      case "refund":
      case "reverse_payment": {
        if (onReversePayment) {
          onReversePayment();
        } else {
          onOpenChange(false);
          navigate("/sales/payments");
        }
        break;
      }
      default:
        break;
    }
  };

  if (!invoice) return null;

  const balance = invoice.total - invoice.amount_paid;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          Reverse Invoice
        </span>
      }
      description={
        <>
          Invoice <strong>{invoice.invoice_number}</strong>
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
                disabled={
                  isSubmitting || !reason.trim() || isPreviewLoading || isPreviewError
                }

              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Void Invoice
              </Button>
            ) : null
          }
        />
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Invoice total</span>
            <span className="font-medium">{formatCurrency(invoice.total, invoice.currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Settled</span>
            <span className="font-medium">
              {formatCurrency(invoice.amount_paid, invoice.currency)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Outstanding</span>
            <span className="font-medium">{formatCurrency(balance, invoice.currency)}</span>
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
              We could not check what is legal for this invoice. Close this panel and try again.
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
                        "Voiding reverses the invoice's postings and keeps the original as history."}
                    </p>
                  </AlertDescription>
                </Alert>

                <ReversalConsequencePreview
                  consequences={consequences}
                  isLoading={isPreviewLoading}
                  isError={isPreviewError}
                  currency={invoice.currency}
                />


                <div className="space-y-2">
                  <Label htmlFor="reason">
                    Reason for voiding <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id="reason"
                    placeholder="e.g., Invoice created for wrong customer, duplicate entry, etc."
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                  />
                </div>
              </>
            ) : (
              <Alert>
                <Lock className="h-4 w-4" />
                <AlertDescription>
                  <p className="font-medium">This invoice cannot be voided.</p>
                  <p className="text-sm mt-1">
                    {voidOption?.blocked_reason ??
                      "The accounting state of this invoice does not allow a void."}
                  </p>
                </AlertDescription>
              </Alert>
            )}

            {alternatives.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {canVoid ? "Other ways to correct this invoice" : "What you can do instead"}
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
