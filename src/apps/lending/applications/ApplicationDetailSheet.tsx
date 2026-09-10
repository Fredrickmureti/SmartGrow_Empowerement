/**
 * Loan application detail sheet — the read-only view of an existing
 * application.
 *
 * Opening an application means "show me what was requested and what has
 * happened to it". Editing is a deliberate act, and only offered while the
 * database guard (`_mf_application_guard`) still accepts a change to the
 * requested terms — after a decision the terms are settled.
 */

import { Pencil } from "lucide-react";
import { DetailSheet, FooterActionBar, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import {
  MF_APPLICATION_STATUS_LABELS,
  type MfApplicationStatus,
  type MfLoanApplication,
} from "@/hooks/useMfApplications";
import {
  applicationEditBlockedReason,
  describeApplicationWorkflow,
} from "@/lib/lending/applicationWorkflow";
import { Block, Field } from "../shared/detailFields";

const STATUS_TONE: Record<
  MfApplicationStatus,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  draft: "neutral",
  submitted: "info",
  under_review: "warning",
  approved: "success",
  rejected: "danger",
  ready_for_disbursement: "info",
  disbursed: "success",
  cancelled: "neutral",
};

interface Props {
  application: MfLoanApplication | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the signed-in user may change applications at all. */
  canManage: boolean;
  /** Whether an assessment exists — shown, and part of the workflow trail. */
  hasAssessment: boolean;
  /** The loan this application produced, if any. */
  loanNumber: string | null;
  clientLabel: string;
  productLabel: string;
  onEdit: () => void;
}

export function ApplicationDetailSheet({
  application,
  open,
  onOpenChange,
  canManage,
  hasAssessment,
  loanNumber,
  clientLabel,
  productLabel,
  onEdit,
}: Props) {
  const { branches } = useBranches();
  const { getUserName } = useOrgMembers();

  if (!application) return null;

  const a = application;
  const { meaning, nextStep } = describeApplicationWorkflow(a.status, hasAssessment, loanNumber);
  // The lifecycle rule is the database's; this only decides whether to offer
  // the action, and says why when it cannot.
  const editBlocked = applicationEditBlockedReason(a.status);
  const branchName = branches.find((b) => b.id === a.branch_id)?.name ?? "—";

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono">{a.application_number}</span>
          <StatusBadge tone={STATUS_TONE[a.status]}>
            {MF_APPLICATION_STATUS_LABELS[a.status]}
          </StatusBadge>
        </span>
      }
      description={clientLabel}
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {canManage &&
                (editBlocked ? (
                  <span title={editBlocked}>
                    <Button disabled>
                      <Pencil className="mr-1.5 h-4 w-4" />
                      Edit application
                    </Button>
                  </span>
                ) : (
                  <Button onClick={onEdit}>
                    <Pencil className="mr-1.5 h-4 w-4" />
                    Edit application
                  </Button>
                ))}
            </>
          }
        />
      }
    >
      <div className="space-y-6">
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <p>{meaning}</p>
          {nextStep && <p className="mt-1 font-medium">Next: {nextStep}</p>}
          {canManage && editBlocked && (
            <p className="mt-1 text-xs text-muted-foreground">{editBlocked}</p>
          )}
        </div>

        <Block title="Application">
          <Field
            label="Reference"
            value={<span className="font-mono">{a.application_number}</span>}
          />
          <Field label="Status" value={MF_APPLICATION_STATUS_LABELS[a.status]} />
          <Field label="Client" value={clientLabel} />
          <Field label="Branch" value={branchName} />
          <Field label="Priced on" value={productLabel} />
          <Field
            label="Loan officer"
            value={a.loan_officer_id ? getUserName(a.loan_officer_id) : "Unassigned"}
          />
          <div className="sm:col-span-2">
            <Field label="Purpose" value={a.purpose} />
          </div>
        </Block>

        <Separator />

        <Block title="Requested terms">
          <Field label="Amount" value={a.requested_amount} />
          <Field label="Term" value={`${a.requested_term_installments} installments`} />
        </Block>

        <Separator />

        <Block title="Decision">
          <Field label="Approved amount" value={a.approved_amount} />
          <Field
            label="Approved term"
            value={
              a.approved_term_installments != null
                ? `${a.approved_term_installments} installments`
                : null
            }
          />
          <Field label="Decided by" value={a.decision_by ? getUserName(a.decision_by) : null} />
          <Field label="Decided at" value={a.decision_at?.slice(0, 10)} />
          <div className="sm:col-span-2">
            <Field label="Decision notes" value={a.decision_notes} />
          </div>
          <div className="sm:col-span-2">
            <Field label="Rejection reason" value={a.rejection_reason} />
          </div>
        </Block>

        <Separator />

        <Block title="Progress">
          <Field label="Business visit assessed" value={hasAssessment ? "Yes" : "No"} />
          <Field label="Loan created" value={loanNumber ?? "Not yet"} />
          <Field label="Submitted at" value={a.submitted_at?.slice(0, 10)} />
          <Field label="Review started" value={a.review_started_at?.slice(0, 10)} />
          <Field label="Cancelled at" value={a.cancelled_at?.slice(0, 10)} />
          <Field label="Cancellation reason" value={a.cancellation_reason} />
        </Block>

        <Separator />

        <Block title="History">
          <Field label="Captured" value={a.created_at?.slice(0, 10)} />
          <Field label="Last changed" value={a.updated_at?.slice(0, 10)} />
        </Block>
      </div>
    </DetailSheet>
  );
}

export default ApplicationDetailSheet;
