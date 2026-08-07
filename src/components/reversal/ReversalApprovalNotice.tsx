/**
 * ReversalApprovalNotice — renders the organization's reversal approval policy
 * verdict inside a reversal sheet (ADR 0129, Phase 5.3).
 *
 * It never decides anything: `reversal_approval_requirement` says whether the
 * reversal is gated and whether the gate is satisfied, and `assert_can_reverse`
 * enforces it server-side. This only makes the verdict visible, and offers the
 * one legitimate next step — raise the request through the approval engine.
 */
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Loader2, ShieldAlert } from "lucide-react";
import type { ReversalApprovalRequirement } from "./useReversalApproval";

interface ReversalApprovalNoticeProps {
  approval: ReversalApprovalRequirement;
  isLoading?: boolean;
  isRequesting?: boolean;
  /** Disabled until the reason code + comment are valid — the request carries them. */
  canRequest: boolean;
  onRequestApproval: () => void;
}

export function ReversalApprovalNotice({
  approval,
  isLoading,
  isRequesting,
  canRequest,
  onRequestApproval,
}: ReversalApprovalNoticeProps) {
  if (isLoading || !approval.required) return null;

  if (approval.satisfied) {
    return (
      <Alert>
        <CheckCircle2 className="h-4 w-4" />
        <AlertTitle>Approved</AlertTitle>
        <AlertDescription>
          An approver has signed off on this reversal. You can complete it now.
        </AlertDescription>
      </Alert>
    );
  }

  const pending =
    approval.request_status === "pending" ||
    approval.request_status === "in_review" ||
    approval.request_status === "escalated";

  return (
    <Alert variant="destructive">
      <ShieldAlert className="h-4 w-4" />
      <AlertTitle className="flex items-center gap-2">
        Approval required
        {approval.request_status ? (
          <Badge variant="outline">{approval.request_status}</Badge>
        ) : null}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <ul className="list-disc space-y-1 pl-4">
          {approval.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        {pending ? (
          <p>
            This reversal is already with an approver. It can be completed as soon
            as the request is approved.
          </p>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={!canRequest || isRequesting}
            onClick={onRequestApproval}
          >
            {isRequesting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Request approval
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
