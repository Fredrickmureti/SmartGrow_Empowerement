/**
 * Canonical employee-loan state machine (client mirror of the DB view
 * `public.employee_loan_state_transitions`).
 *
 * The DB is the enforcement point: every `employee_loan_*` RPC calls
 * `_loan_assert_transition` before mutating a loan, so the server will
 * reject an illegal move with SQLSTATE `22023` / HINT `LOAN_STATE_INVALID`
 * regardless of what the client offers. This mirror exists so the UI can
 * render the correct buttons **without** round-tripping and so tests can
 * pin the two lists together.
 *
 * Keep this file and the DB view in sync — the architecture test
 * `employee-loan-lifecycle.test.ts` will fail if they drift.
 */
export type LoanStatus =
  | "draft"
  | "requested"
  | "pending_approval"
  | "approved"
  | "awaiting_disbursement"
  | "active"
  | "in_arrears"
  | "paused"
  | "suspended"
  | "rejected"
  | "cancelled"
  | "completed"
  | "written_off"
  | "restructured"
  | "closed_on_termination";

export type LoanEvent =
  | "submit"
  | "approve"
  | "reject"
  | "cancel"
  | "authorize_disbursement"
  | "cancel_authorization"
  | "disburse"
  | "pause"
  | "resume"
  | "suspend"
  | "enter_arrears"
  | "exit_arrears"
  | "settle"
  | "write_off"
  | "restructure"
  | "close_on_termination";

interface Transition {
  from: LoanStatus;
  event: LoanEvent;
  to: LoanStatus;
}

export const LOAN_TRANSITIONS: readonly Transition[] = [
  { from: "draft", event: "submit", to: "pending_approval" },
  { from: "requested", event: "submit", to: "pending_approval" },
  { from: "rejected", event: "submit", to: "pending_approval" },
  { from: "pending_approval", event: "approve", to: "approved" },
  { from: "pending_approval", event: "reject", to: "rejected" },
  { from: "pending_approval", event: "cancel", to: "cancelled" },
  { from: "approved", event: "authorize_disbursement", to: "awaiting_disbursement" },
  { from: "approved", event: "cancel", to: "cancelled" },
  { from: "awaiting_disbursement", event: "disburse", to: "active" },
  { from: "awaiting_disbursement", event: "cancel_authorization", to: "approved" },
  { from: "awaiting_disbursement", event: "cancel", to: "cancelled" },
  { from: "awaiting_disbursement", event: "suspend", to: "suspended" },
  { from: "active", event: "enter_arrears", to: "in_arrears" },
  { from: "active", event: "pause", to: "paused" },
  { from: "active", event: "suspend", to: "suspended" },
  { from: "active", event: "settle", to: "completed" },
  { from: "active", event: "write_off", to: "written_off" },
  { from: "active", event: "restructure", to: "restructured" },
  { from: "active", event: "close_on_termination", to: "closed_on_termination" },
  { from: "in_arrears", event: "exit_arrears", to: "active" },
  { from: "in_arrears", event: "pause", to: "paused" },
  { from: "in_arrears", event: "settle", to: "completed" },
  { from: "in_arrears", event: "write_off", to: "written_off" },
  { from: "in_arrears", event: "restructure", to: "restructured" },
  { from: "in_arrears", event: "close_on_termination", to: "closed_on_termination" },
  { from: "paused", event: "resume", to: "active" },
  { from: "paused", event: "settle", to: "completed" },
  { from: "paused", event: "write_off", to: "written_off" },
  { from: "paused", event: "restructure", to: "restructured" },
  { from: "paused", event: "close_on_termination", to: "closed_on_termination" },
  { from: "restructured", event: "settle", to: "completed" },
  { from: "suspended", event: "resume", to: "active" },
  { from: "suspended", event: "cancel", to: "cancelled" },
];

export const TERMINAL_STATUSES: readonly LoanStatus[] = [
  "completed",
  "written_off",
  "cancelled",
  "rejected",
  "restructured",
  "closed_on_termination",
];

export function canTransition(from: LoanStatus, event: LoanEvent): boolean {
  return LOAN_TRANSITIONS.some((t) => t.from === from && t.event === event);
}

export function nextStatus(from: LoanStatus, event: LoanEvent): LoanStatus | null {
  return LOAN_TRANSITIONS.find((t) => t.from === from && t.event === event)?.to ?? null;
}

export function isTerminal(status: LoanStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Loan facts the action resolver needs beyond `status`. Kept minimal so
 * callers can build it from any loan shape (portal or admin).
 */
export interface LoanFacts {
  status: LoanStatus;
  outstandingBalance: number;
  hasDisbursementJournal: boolean;
}

const SETTLEMENT_TOLERANCE = 0.005;

/**
 * Derive the set of user-facing actions offered for a loan. The DB will
 * still reject anything illegal — this is the presentation contract.
 */
export function getAvailableActions(loan: LoanFacts): Set<LoanEvent> {
  const out = new Set<LoanEvent>();
  const { status, outstandingBalance, hasDisbursementJournal } = loan;

  // Legal transitions from the state machine.
  for (const t of LOAN_TRANSITIONS) {
    if (t.from !== status) continue;

    // Business gates on top of pure state legality:
    if (t.event === "disburse" && hasDisbursementJournal) continue;
    if (t.event === "settle" && outstandingBalance > SETTLEMENT_TOLERANCE) continue;
    if (t.event === "write_off" && outstandingBalance <= SETTLEMENT_TOLERANCE) continue;

    out.add(t.event);
  }
  return out;
}
