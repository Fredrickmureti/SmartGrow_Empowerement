/**
 * The application → loan → disbursement chain, described for the operator.
 *
 * This is a presentation mirror of the guards in `_mf_application_guard`,
 * `mf_create_loan_from_application` and `mf_disburse_loan`. It never decides
 * anything: the database remains authoritative and still refuses an invalid
 * event even when the UI offers it. Its only job is to tell a first-time user
 * what has already happened, what happens next, and why something else is not
 * available yet.
 */
import type { MfApplicationStatus } from "@/hooks/useMfApplications";

export interface WorkflowStep {
  label: string;
  done: boolean;
}

export interface ApplicationWorkflow {
  /** What the current state means in business terms. */
  meaning: string;
  /** The next legitimate business event, or null when the chain has ended. */
  nextStep: string | null;
  /** Events already completed, in chronological order. */
  steps: WorkflowStep[];
}

const ORDER: MfApplicationStatus[] = [
  "draft",
  "submitted",
  "under_review",
  "approved",
  "ready_for_disbursement",
  "disbursed",
];

const MEANING: Record<MfApplicationStatus, string> = {
  draft: "Captured but not yet submitted — the terms can still be edited.",
  submitted: "Submitted for review. The product's eligibility rules have passed.",
  under_review: "With the reviewer. A business visit must be recorded before a decision.",
  approved:
    "Approved with an amount and term inside the product band. Approval is not disbursement.",
  rejected: "Declined, with the reason on record. The application is closed.",
  ready_for_disbursement:
    "The loan has been created with its contractual schedule and is waiting to be paid out.",
  disbursed: "The money has been paid out and the loan is active.",
  cancelled: "Withdrawn before a decision. The application is closed.",
};

/**
 * @param status      the stored application status
 * @param hasAssessment whether at least one assessment exists
 * @param loanNumber  the loan minted from this application, if any
 */
export function describeApplicationWorkflow(
  status: MfApplicationStatus,
  hasAssessment: boolean,
  loanNumber?: string | null,
): ApplicationWorkflow {
  const reached = (s: MfApplicationStatus) => {
    const at = ORDER.indexOf(status);
    const of = ORDER.indexOf(s);
    return at >= 0 && of >= 0 && at >= of;
  };

  const steps: WorkflowStep[] = [
    { label: "Application captured", done: true },
    { label: "Submitted", done: reached("submitted") },
    { label: "Business visit assessed", done: hasAssessment },
    {
      label: status === "rejected" ? "Declined" : "Approved",
      done: status === "rejected" || reached("approved"),
    },
    { label: "Loan created", done: reached("ready_for_disbursement") },
    { label: "Disbursed", done: status === "disbursed" },
  ];

  let nextStep: string | null = null;
  switch (status) {
    case "draft":
      nextStep = "Submit the application for review";
      break;
    case "submitted":
      nextStep = "Start the review, then record the business visit";
      break;
    case "under_review":
      nextStep = hasAssessment
        ? "Approve or decline the application"
        : "Record the business visit assessment";
      break;
    case "approved":
      nextStep = "Create the loan — this freezes the terms and builds the schedule";
      break;
    case "ready_for_disbursement":
      nextStep = loanNumber
        ? `Disburse ${loanNumber} on the Loans page`
        : "Create the loan for this application";
      break;
    default:
      nextStep = null;
  }

  return { meaning: MEANING[status], nextStep, steps };
}

/** Why a decision is not available yet, or null when it is. */
export function decisionBlockedReason(
  status: MfApplicationStatus,
  hasAssessment: boolean,
): string | null {
  if (status !== "under_review") {
    return "An application can only be decided while it is under review.";
  }
  if (!hasAssessment) {
    return "Record the business visit assessment before deciding this application.";
  }
  return null;
}

/**
 * Why the requested terms can no longer be edited, or null when they can.
 *
 * A presentation mirror of `_mf_application_guard`, which refuses a change to
 * the amount, term, client or product once the application has been decided,
 * turned into a loan, disbursed or withdrawn. The database stays the control.
 */
export function applicationEditBlockedReason(
  status: MfApplicationStatus,
): string | null {
  switch (status) {
    case "draft":
    case "submitted":
    case "under_review":
      return null;
    case "approved":
      return "Approved — the terms are settled and can no longer be edited.";
    case "rejected":
      return "Declined — the application is closed and stays on record as it was.";
    case "ready_for_disbursement":
      return "A loan has been created from this application; its terms are frozen.";
    case "disbursed":
      return "Disbursed — the loan governs from here.";
    case "cancelled":
      return "Withdrawn — the application is closed and stays on record as it was.";
  }
}
