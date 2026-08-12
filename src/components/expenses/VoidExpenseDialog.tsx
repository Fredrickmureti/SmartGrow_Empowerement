import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Ban, Loader2 } from "lucide-react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { useCurrency } from "@/hooks/useCurrency";
import {
  useTransactionReversal,
  type ReversalIntent,
} from "@/hooks/useTransactionReversal";
import { ReversalConsequencePreview } from "@/components/reversal/ReversalConsequencePreview";
import { useReversalConsequences } from "@/components/reversal/useReversalConsequences";
import { ReversalReasonField } from "@/components/reversal/ReversalReasonField";
import { ReversalApprovalNotice } from "@/components/reversal/ReversalApprovalNotice";
import { useReversalApproval } from "@/components/reversal/useReversalApproval";
import {
  useReversalReasonCodes,
  isReversalReasonComplete,
} from "@/components/reversal/useReversalReasonCodes";

/**
 * Reversal intent step for an expense (ADR 0134).
 *
 * Voiding an expense used to be a bare dropdown item with an auto-generated
 * reason: no reason code, no preview, no approval gate — while the identical
 * action on a bill demanded all three. Worse, an expense queued for payroll
 * reimbursement stayed queued after the void, so the employee was still paid.
 *
 * This sheet decides nothing. `resolve_reversal_intent('expense', …)` decides
 * on the server from status, fiscal period, reimbursement state, the payroll
 * queue and any bill raised from the expense; `preview_reversal_consequences`
 * shows what the void will do. Confirming calls `expense_void`, the single
 * writer. Do not reintroduce a direct `voidExpense` call from a menu.
 */
interface VoidExpenseDialogProps {
  expense: {
    id: string;
    expense_number?: string | null;
    description?: string | null;
    amount: number;
    currency?: string | null;
    status: string;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (args: { id: string; reason: string; reasonCode: string }) => Promise<void>;
  onSuccess?: () => void;
}

const BLOCKER_LABELS: Record<string, string> = {
  already_reversed: "Already voided",
  settled: "Already reimbursed",
  billed: "Converted to a vendor bill",
  period_closed: "Period closed",
  queued_for_payroll: "Queued for payroll reimbursement",
};

export function VoidExpenseDialog({
  expense,
  open,
  onOpenChange,
  onConfirm,
  onSuccess,
}: VoidExpenseDialogProps) {
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [intent, setIntent] = useState<ReversalIntent | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const { resolveReversalIntent } = useTransactionReversal();
  const { formatCurrency } = useCurrency();

  const { reasonCodes, isLoading: isLoadingReasons } = useReversalReasonCodes("expense", open);
  const reasonComplete = isReversalReasonComplete(reasonCodes, reasonCode, reason);

  const {
    approval,
    isBlockedPendingApproval,
    isLoading: isLoadingApproval,
    requestApproval,
    isRequesting: isRequestingApproval,
  } = useReversalApproval("expense", expense?.id, "void", open);

  // Re-resolved per expense — payroll queue and period state move underneath.
  useEffect(() => {
    if (!open || !expense) {
      setIntent(null);
      return;
    }
    let cancelled = false;
    setIsResolving(true);
    setReason("");
    setReasonCode("");

    resolveReversalIntent("expense", expense.id)
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
  }, [open, expense?.id]);

  const voidOption = intent?.operations.find((op) => op.operation === "void");
  const canVoid = Boolean(voidOption?.allowed);

  const {
    consequences,
    isLoading: isPreviewLoading,
    isError: isPreviewError,
  } = useReversalConsequences("expense", expense?.id, open && canVoid);

  const handleVoid = async () => {
    if (!expense || !reasonComplete || !canVoid || isBlockedPendingApproval) return;
    setIsSubmitting(true);
    try {
      await onConfirm({ id: expense.id, reason: reason.trim(), reasonCode });
      setReason("");
      setReasonCode("");
      onOpenChange(false);
      onSuccess?.();
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!expense) return null;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          Reverse Expense
        </span>
      }
      description={
        <>
          Expense <strong>{expense.expense_number ?? expense.description ?? expense.id}</strong>
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
                  isSubmitting ||
                  !reasonComplete ||
                  isPreviewLoading ||
                  isPreviewError ||
                  isBlockedPendingApproval
                }
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Void Expense
              </Button>
            ) : null
          }
        />
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount</span>
            <span className="font-medium">
              {formatCurrency(expense.amount, expense.currency ?? undefined)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Status</span>
            <span className="font-medium capitalize">{expense.status}</span>
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
              We could not check what is legal for this expense. Close this panel and try again.
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
                <ReversalConsequencePreview
                  consequences={consequences}
                  isLoading={isPreviewLoading}
                  isError={isPreviewError}
                  currency={expense.currency ?? undefined}
                />

                <ReversalApprovalNotice
                  approval={approval}
                  isLoading={isLoadingApproval}
                  onRequestApproval={() => requestApproval(reasonCode, reason.trim())}
                  isRequesting={isRequestingApproval}
                />

                <ReversalReasonField
                  documentType="expense"
                  idPrefix="void-expense"
                  reasonCodes={reasonCodes}
                  isLoading={isLoadingReasons}
                  code={reasonCode}
                  onCodeChange={setReasonCode}
                  comment={reason}
                  onCommentChange={setReason}
                  disabled={isSubmitting}
                />
              </>
            ) : (
              <Alert>
                <Ban className="h-4 w-4" />
                <AlertDescription>
                  {voidOption?.blocked_reason ??
                    "This expense cannot be voided in its current state."}
                </AlertDescription>
              </Alert>
            )}
          </>
        )}
      </div>
    </DetailSheet>
  );
}
