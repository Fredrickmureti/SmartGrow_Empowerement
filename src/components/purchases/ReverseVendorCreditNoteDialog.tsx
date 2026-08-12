/**
 * ReverseVendorCreditNoteDialog — ADR 0132 Phase 4 operator surface for
 * reversing a POSTED vendor credit note.
 *
 * Built as the sibling of `ReverseGoodsReceiptDialog`: this sheet decides
 * nothing. `resolve_reversal_intent('vendor_credit_note', …)` decides legality
 * on the server from posting / already-reversed state, and
 * `preview_reversal_consequences` shows the GL and settlement consequences
 * before anyone authorises them. Confirming calls
 * `reverse_vendor_credit_note_atomic`, the single writer, which unwinds bill
 * applications, voids the journal entry and gives the credit balance back in
 * one transaction.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { ReversalConsequencePreview } from "@/components/reversal/ReversalConsequencePreview";
import { useReversalConsequences } from "@/components/reversal/useReversalConsequences";
import { ReversalReasonField } from "@/components/reversal/ReversalReasonField";
import { ReversalApprovalNotice } from "@/components/reversal/ReversalApprovalNotice";
import { useReversalApproval } from "@/components/reversal/useReversalApproval";
import {
  useReversalReasonCodes,
  isReversalReasonComplete,
} from "@/components/reversal/useReversalReasonCodes";
import { useTransactionReversal } from "@/hooks/useTransactionReversal";
import { AlertTriangle, Loader2, Lock } from "lucide-react";

/**
 * Shape returned by `resolve_reversal_intent_vendor_credit_note`. It is the
 * AP-specific projection (three-part status + applied total), not the finance
 * intent shape — never widen it in the client.
 */
interface VendorCreditNoteIntent {
  document_number: string;
  commercial_status: string;
  accounting_status: string;
  settlement_status: string;
  total: number;
  applied_total: number;
  period_open: boolean;
  blockers: string[];
  operations: Array<{
    operation: string;
    allowed: boolean;
    label: string;
    effect?: string | null;
    blocked_reason?: string | null;
  }>;
}

interface ReverseVendorCreditNoteDialogProps {
  creditNote: {
    id: string;
    credit_note_number: string;
    currency?: string | null;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function ReverseVendorCreditNoteDialog({
  creditNote,
  open,
  onOpenChange,
  onSuccess,
}: ReverseVendorCreditNoteDialogProps) {
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [intent, setIntent] = useState<VendorCreditNoteIntent | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const { reverseVendorCreditNote, resolveReversalIntent } = useTransactionReversal();

  // One shared vocabulary (ADR 0129) — the same codes the writer validates.
  const { reasonCodes, isLoading: isLoadingReasons } = useReversalReasonCodes(
    "vendor_credit_note",
    open,
  );
  const reasonComplete = isReversalReasonComplete(reasonCodes, reasonCode, reason);

  const {
    approval,
    isBlockedPendingApproval,
    isLoading: isLoadingApproval,
    requestApproval,
    isRequesting: isRequestingApproval,
  } = useReversalApproval("vendor_credit_note", creditNote?.id, "reverse", open);

  // Re-resolved per note on open: applications and period state move underneath
  // a long-lived sheet, so a cached verdict would authorise the wrong thing.
  useEffect(() => {
    if (!open || !creditNote) {
      setIntent(null);
      return;
    }
    let cancelled = false;
    setIsResolving(true);
    setReason("");
    setReasonCode("");

    resolveReversalIntent("vendor_credit_note", creditNote.id)
      .then((result) => {
        if (!cancelled) setIntent((result as unknown as VendorCreditNoteIntent) ?? null);
      })
      .finally(() => {
        if (!cancelled) setIsResolving(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, creditNote?.id]);

  const reverseOption = intent?.operations.find((op) => op.operation === "reverse");
  const canReverse = Boolean(reverseOption?.allowed);

  const {
    consequences,
    isLoading: isPreviewLoading,
    isError: isPreviewError,
  } = useReversalConsequences("vendor_credit_note", creditNote?.id, open && canReverse);

  const handleReverse = async () => {
    if (!creditNote || !reasonComplete || !canReverse || isBlockedPendingApproval) return;
    setIsSubmitting(true);
    try {
      const success = await reverseVendorCreditNote({
        creditNoteId: creditNote.id,
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

  if (!creditNote) return null;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          Reverse Vendor Credit Note
        </span>
      }
      description={
        <>
          Credit note <strong>{creditNote.credit_note_number}</strong>
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
                disabled={
                  isSubmitting ||
                  !reasonComplete ||
                  isPreviewLoading ||
                  isPreviewError ||
                  isBlockedPendingApproval
                }
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Reverse Credit Note
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
              We could not check what is legal for this credit note. Close this panel and try again.
            </AlertDescription>
          </Alert>
        )}

        {!isResolving && intent && (
          <>
            {intent.blockers.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {intent.blockers.map((blocker) => (
                  <Badge key={blocker} variant="outline">
                    {blocker}
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
                      {reverseOption?.effect ??
                        "Reversing gives the credit back, restores any bills it settled and reverses the credit note posting. The credit note stays as history."}
                    </p>
                  </AlertDescription>
                </Alert>

                <ReversalConsequencePreview
                  consequences={consequences}
                  isLoading={isPreviewLoading}
                  isError={isPreviewError}
                  currency={creditNote.currency ?? undefined}
                />

                <ReversalApprovalNotice
                  approval={approval}
                  isLoading={isLoadingApproval}
                  isRequesting={isRequestingApproval}
                  canRequest={reasonComplete}
                  onRequestApproval={() => requestApproval(reasonCode, reason.trim())}
                />

                <ReversalReasonField
                  documentType="vendor_credit_note"
                  idPrefix="vcn-reverse"
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
                  <p className="font-medium">This credit note cannot be reversed.</p>
                  <p className="text-sm mt-1">
                    {reverseOption?.blocked_reason ??
                      "The accounting state of this credit note does not allow a reversal."}
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
