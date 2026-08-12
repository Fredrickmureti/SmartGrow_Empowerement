import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Ban, Receipt } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { useCurrency } from "@/hooks/useCurrency";
import {
  useTransactionReversal,
  type ReversalIntent,
} from "@/hooks/useTransactionReversal";
import { ReversalConsequencePreview } from "@/components/reversal/ReversalConsequencePreview";
import { useReversalConsequences } from "@/components/reversal/useReversalConsequences";

/**
 * Reversal surface for a customer refund (ADR 0134).
 *
 * A refund is cash that has already left the bank. `customer_refund` gained a
 * server-side intent resolver, but until now no screen ever asked it — so the
 * only way a user learned that a refund is not voidable was to not find a
 * button. That is an absence, not an answer: the ledger showed a refund row and
 * the system said nothing about how to correct it.
 *
 * This sheet decides nothing. `resolve_reversal_intent('customer_refund', …)`
 * decides, and `preview_reversal_consequences` shows what a reversal would
 * touch (the bank leg, the receipt or credit note the refund was drawn from).
 * Today the resolver refuses every operation and names the corrective move —
 * record a customer receipt for the money coming back — so this surface's job
 * is to state that plainly and route there. If the resolver ever allows an
 * operation, this sheet renders it like any other reversal surface rather than
 * growing a second policy.
 */
interface ReverseCustomerRefundSheetProps {
  refund: {
    id: string;
    reference?: string | null;
    amount?: number | null;
    currency?: string | null;
    refundDate?: string | null;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Customer whose ledger this refund belongs to — used for the corrective route. */
  customerId?: string | null;
}

const BLOCKER_LABELS: Record<string, string> = {
  already_reversed: "Already voided",
  period_closed: "Period closed",
};

export function ReverseCustomerRefundSheet({
  refund,
  open,
  onOpenChange,
  customerId,
}: ReverseCustomerRefundSheetProps) {
  const [intent, setIntent] = useState<ReversalIntent | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const { resolveReversalIntent } = useTransactionReversal();
  const { formatCurrency } = useCurrency();

  // Re-resolved per refund: period state and void state move underneath.
  useEffect(() => {
    if (!open || !refund) {
      setIntent(null);
      return;
    }
    let cancelled = false;
    setIsResolving(true);
    resolveReversalIntent("customer_refund", refund.id)
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
  }, [open, refund?.id]);

  const voidOption = intent?.operations.find((op) => op.operation === "void");
  const allowedOption = intent?.operations.find((op) => op.allowed);

  const {
    consequences,
    isLoading: isPreviewLoading,
    isError: isPreviewError,
  } = useReversalConsequences("customer_refund", refund?.id, open);

  if (!refund) return null;

  const receiptHref = customerId
    ? `/sales/payments?customer=${customerId}`
    : "/sales/payments";

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          Reverse Customer Refund
        </span>
      }
      description={
        <>
          Refund <strong>{refund.reference ?? refund.id}</strong>
        </>
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          }
          trailing={
            allowedOption ? null : (
              <Button asChild onClick={() => onOpenChange(false)}>
                <Link to={receiptHref}>
                  <Receipt className="mr-2 h-4 w-4" />
                  Record customer receipt
                </Link>
              </Button>
            )
          }
        />
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount refunded</span>
            <span className="font-medium">
              {formatCurrency(refund.amount ?? 0, refund.currency ?? undefined)}
            </span>
          </div>
          {refund.refundDate && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Refund date</span>
              <span className="font-medium">{refund.refundDate}</span>
            </div>
          )}
          {intent && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <span className="font-medium capitalize">{intent.status}</span>
            </div>
          )}
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
              We could not check what is legal for this refund. Close this panel and try again.
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

            <Alert>
              <Ban className="h-4 w-4" />
              <AlertDescription>
                {allowedOption?.description ??
                  voidOption?.blocked_reason ??
                  "This refund cannot be reversed in its current state."}
              </AlertDescription>
            </Alert>

            <ReversalConsequencePreview
              consequences={consequences}
              isLoading={isPreviewLoading}
              isError={isPreviewError}
              currency={refund.currency ?? undefined}
            />
          </>
        )}
      </div>
    </DetailSheet>
  );
}
