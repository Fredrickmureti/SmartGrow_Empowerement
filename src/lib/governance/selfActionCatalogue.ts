/**
 * Canonical catalogue of sensitive action keys governed by the
 * Self-Action Policy framework (see Migration 1 in Wave G2).
 *
 * Each entry now declares the *entity type* it operates on and how the
 * "subject" user is derived. This is what powers the state-driven
 * Override dialog — admins pick an action, the dialog knows which
 * table to search for the target record, and the subject user is
 * either the actor themselves (plain self-approval) or pulled off
 * the chosen entity (`*_self_benefit` actions on employee records).
 */

export type SelfActionEntityType =
  | "payroll_run"
  | "payroll_payment_batch"
  | "leave_request"
  | "timesheet_submission"
  | "employee_loan"
  | "employee_compensation_change"
  | "employee_contract"
  | "bill"
  | "bill_payment"
  | "payment"
  | "journal_entry"
  | "customer_refund"
  | "purchase_requisition"
  | "rfq"
  | "purchase_order"
  | "vendor_credit_note"
  | "credit_note"
  | "stock_adjustment"
  | "stock_transfer"
  | "expense"
  | "bank_account"
  | "payroll_run_loan_skip_override";

/**
 * How the override's `subject_user_id` is resolved.
 *  - `actor`        → subject == actor (plain self-approval; "do not approve your own X")
 *  - `from_entity`  → subject is read off the picked entity row (e.g. expense.employee_id → employees.user_id)
 */
export type SubjectMode = "actor" | "from_entity";

export interface SelfActionEntry {
  key: string;
  module: "Payroll" | "HR" | "Finance" | "Purchasing" | "Sales" | "Inventory" | "Spend";
  label: string;
  description: string;
  entityType: SelfActionEntityType;
  subjectMode: SubjectMode;
}

export const SELF_ACTION_CATALOGUE: SelfActionEntry[] = [
  // Payroll
  {
    key: "payroll.approve",
    module: "Payroll",
    label: "Approve payroll run",
    description: "Approve a payroll run that includes the approver's own payslip.",
    entityType: "payroll_run",
    subjectMode: "actor",
  },
  // Payroll → Payments (lifecycle of a disbursement batch)
  // Mirrors the action keys checked by sod_payroll_payment_batches_guard:
  //   payroll_payment_batch.approve | .lock | .transmit | .pay | .cancel | .reverse
  {
    key: "payroll_payment_batch.approve",
    module: "Payroll",
    label: "Approve own payment batch",
    description: "Approve a payroll payment batch that the approver created.",
    entityType: "payroll_payment_batch",
    subjectMode: "actor",
  },
  {
    key: "payroll_payment_batch.lock",
    module: "Payroll",
    label: "Lock own payment batch",
    description: "Lock a payroll payment batch that the approver created.",
    entityType: "payroll_payment_batch",
    subjectMode: "actor",
  },
  {
    key: "payroll_payment_batch.transmit",
    module: "Payroll",
    label: "Transmit own payment batch",
    description: "Mark as transmitted a payment batch the approver created.",
    entityType: "payroll_payment_batch",
    subjectMode: "actor",
  },
  {
    key: "payroll_payment_batch.pay",
    module: "Payroll",
    label: "Confirm payment of own batch",
    description: "Mark as paid (confirm bank disbursement) a batch the approver created.",
    entityType: "payroll_payment_batch",
    subjectMode: "actor",
  },
  {
    key: "payroll_payment_batch.cancel",
    module: "Payroll",
    label: "Cancel own payment batch",
    description: "Cancel a payroll payment batch the approver created.",
    entityType: "payroll_payment_batch",
    subjectMode: "actor",
  },
  {
    key: "payroll_payment_batch.reverse",
    module: "Payroll",
    label: "Reverse own payment batch",
    description: "Reverse a posted payroll payment batch the approver created.",
    entityType: "payroll_payment_batch",
    subjectMode: "actor",
  },
  // Payroll → Loan skip overrides (maker-checker on payroll exceptions)
  {
    key: "payroll.loan_skip_override.approve",
    module: "Payroll",
    label: "Approve own loan skip override",
    description: "Approve a payroll loan-skip override that the approver themselves submitted.",
    entityType: "payroll_run_loan_skip_override",
    subjectMode: "actor",
  },
  {
    key: "payroll.loan_skip_override.reject",
    module: "Payroll",
    label: "Reject own loan skip override",
    description: "Reject a payroll loan-skip override that the approver themselves submitted.",
    entityType: "payroll_run_loan_skip_override",
    subjectMode: "actor",
  },
  {
    key: "payroll.loan_skip_override.cancel",
    module: "Payroll",
    label: "Cancel own approved loan skip override",
    description: "Cancel a loan-skip override after the approver themselves approved it.",
    entityType: "payroll_run_loan_skip_override",
    subjectMode: "actor",
  },
  // HR
  {
    key: "leave.approve",
    module: "HR",
    label: "Approve leave (level 1)",
    description: "Approve a leave request submitted by the approver themselves.",
    entityType: "leave_request",
    subjectMode: "from_entity",
  },
  {
    key: "leave.approve_l2",
    module: "HR",
    label: "Approve leave (level 2)",
    description: "Second-level approval on the approver's own leave request.",
    entityType: "leave_request",
    subjectMode: "from_entity",
  },
  {
    key: "timesheet.approve",
    module: "HR",
    label: "Approve own timesheet",
    description: "Approve a timesheet submitted by the approver themselves.",
    entityType: "timesheet_submission",
    subjectMode: "from_entity",
  },
  {
    key: "loan.approve",
    module: "HR",
    label: "Approve loan (creator)",
    description: "Approve an employee loan the approver created.",
    entityType: "employee_loan",
    subjectMode: "actor",
  },
  {
    key: "loan.approve_self_benefit",
    module: "HR",
    label: "Approve own loan",
    description: "Approve an employee loan whose beneficiary is the approver.",
    entityType: "employee_loan",
    subjectMode: "from_entity",
  },
  // Employee loan lifecycle (Phase L-B). Mirrors the action keys checked
  // by the new loan lifecycle RPCs / guard:
  //   employee_loan.authorize_disbursement | .write_off | .restructure |
  //   .refinance | .record_manual_repayment
  {
    key: "employee_loan.authorize_disbursement",
    module: "HR",
    label: "Authorize disbursement of own loan",
    description: "Release a loan to disbursement that the approver themselves approved.",
    entityType: "employee_loan",
    subjectMode: "actor",
  },
  {
    key: "employee_loan.write_off",
    module: "HR",
    label: "Write off own loan",
    description: "Write off a loan that the writer originated. Requires a distinct co-signer (dual control).",
    entityType: "employee_loan",
    subjectMode: "actor",
  },
  {
    key: "employee_loan.restructure",
    module: "HR",
    label: "Restructure own loan",
    description: "Restructure, refinance, top-up or consolidate a loan the actor created.",
    entityType: "employee_loan",
    subjectMode: "actor",
  },
  {
    key: "employee_loan.refinance",
    module: "HR",
    label: "Refinance own loan",
    description: "Refinance a loan the actor created (covered by restructure trigger).",
    entityType: "employee_loan",
    subjectMode: "actor",
  },
  {
    key: "employee_loan.record_manual_repayment",
    module: "HR",
    label: "Record manual repayment on own loan",
    description: "Post a manual (non-payroll) repayment against a loan the actor created.",
    entityType: "employee_loan",
    subjectMode: "actor",
  },
  {
    key: "compensation.approve",
    module: "HR",
    label: "Approve compensation change (creator)",
    description: "Approve a compensation change the approver authored.",
    entityType: "employee_compensation_change",
    subjectMode: "actor",
  },
  {
    key: "compensation.approve_self_benefit",
    module: "HR",
    label: "Approve own compensation change",
    description: "Approve a compensation change whose subject is the approver.",
    entityType: "employee_compensation_change",
    subjectMode: "from_entity",
  },
  {
    key: "contract.approve",
    module: "HR",
    label: "Approve employee contract (creator)",
    description: "Approve an employment contract the approver authored.",
    entityType: "employee_contract",
    subjectMode: "actor",
  },
  {
    key: "contract.approve_self_benefit",
    module: "HR",
    label: "Approve own contract",
    description: "Approve an employment contract whose subject is the approver.",
    entityType: "employee_contract",
    subjectMode: "from_entity",
  },
  // Finance
  {
    key: "bill.approve",
    module: "Finance",
    label: "Approve own bill",
    description: "Approve a vendor bill recorded by the approver.",
    entityType: "bill",
    subjectMode: "actor",
  },
  {
    key: "bill_payment.approve",
    module: "Finance",
    label: "Approve own bill payment",
    description: "Approve a bill payment recorded by the approver.",
    entityType: "bill_payment",
    subjectMode: "actor",
  },
  {
    key: "payment.approve",
    module: "Finance",
    label: "Approve own payment",
    description: "Approve a payment the approver recorded.",
    entityType: "payment",
    subjectMode: "actor",
  },
  {
    key: "journal.post",
    module: "Finance",
    label: "Post own journal entry",
    description: "Post a journal entry the approver created.",
    entityType: "journal_entry",
    subjectMode: "actor",
  },
  {
    key: "customer_refund.approve",
    module: "Finance",
    label: "Approve own customer refund",
    description: "Approve a customer refund the approver created.",
    entityType: "customer_refund",
    subjectMode: "actor",
  },
  // Purchasing
  {
    key: "requisition.approve",
    module: "Purchasing",
    label: "Approve own requisition",
    description: "Approve a purchase requisition submitted by the approver.",
    entityType: "purchase_requisition",
    subjectMode: "actor",
  },
  {
    key: "rfq.approve",
    module: "Purchasing",
    label: "Approve own RFQ",
    description: "Approve a request for quotation submitted by the approver.",
    entityType: "rfq",
    subjectMode: "actor",
  },
  {
    key: "rfq.award",
    module: "Purchasing",
    label: "Award own RFQ",
    description: "Award a request for quotation submitted or approved by the actor.",
    entityType: "rfq",
    subjectMode: "actor",
  },
  {
    key: "purchase_order.approve",
    module: "Purchasing",
    label: "Approve own purchase order",
    description: "Approve a purchase order the approver created.",
    entityType: "purchase_order",
    subjectMode: "actor",
  },
  {
    key: "vendor_credit_note.approve",
    module: "Purchasing",
    label: "Approve own vendor credit note",
    description: "Approve a vendor credit note the approver created.",
    entityType: "vendor_credit_note",
    subjectMode: "actor",
  },
  // Sales
  {
    key: "credit_note.approve",
    module: "Sales",
    label: "Approve own sales credit note",
    description: "Approve a sales credit note the approver created.",
    entityType: "credit_note",
    subjectMode: "actor",
  },
  // Inventory
  {
    key: "inventory.approve_adjustment",
    module: "Inventory",
    label: "Approve own stock adjustment",
    description: "Approve a stock adjustment the approver created.",
    entityType: "stock_adjustment",
    subjectMode: "actor",
  },
  {
    key: "inventory.approve_transfer",
    module: "Inventory",
    label: "Approve own stock transfer",
    description: "Approve a stock transfer the approver requested.",
    entityType: "stock_transfer",
    subjectMode: "actor",
  },
  {
    key: "inventory.submit_count",
    module: "Inventory",
    label: "Submit own physical count",
    description: "Submit a physical count for review that the submitter created.",
    entityType: "stock_adjustment",
    subjectMode: "actor",
  },
  {
    key: "inventory.approve_count",
    module: "Inventory",
    label: "Approve own physical count",
    description: "Approve a physical count that the approver created, froze, or submitted.",
    entityType: "stock_adjustment",
    subjectMode: "actor",
  },
  {
    key: "inventory.post_count",
    module: "Inventory",
    label: "Post own physical count",
    description: "Post a physical count that the poster previously approved.",
    entityType: "stock_adjustment",
    subjectMode: "actor",
  },
  {
    key: "scrap.approve",
    module: "Inventory",
    label: "Approve own scrap / waste",
    description:
      "Approve a scrap / waste document the approver recorded. Blocks self-approval unless a governance override is issued.",
    entityType: "stock_adjustment",
    subjectMode: "actor",
  },
  {
    key: "scrap.post",
    module: "Inventory",
    label: "Post own scrap / waste",
    description:
      "Post a scrap / waste document the poster recorded. Blocks self-posting when policy requires a distinct reviewer.",
    entityType: "stock_adjustment",
    subjectMode: "actor",
  },
  {
    key: "scrap.reverse",
    module: "Inventory",
    label: "Reverse own scrap / waste",
    description:
      "Reverse a scrap / waste document the reverser posted. Blocks self-reversal to preserve audit trail.",
    entityType: "stock_adjustment",
    subjectMode: "actor",
  },
  // Spend
  {
    key: "expense.approve",
    module: "Spend",
    label: "Approve own expense",
    description: "Approve an expense the approver recorded.",
    entityType: "expense",
    subjectMode: "actor",
  },
  {
    key: "expense.approve_self_benefit",
    module: "Spend",
    label: "Approve expense for own employee record",
    description: "Approve an expense whose employee is the approver.",
    entityType: "expense",
    subjectMode: "from_entity",
  },
  // Finance — sensitive field changes (Wave G5)
  {
    key: "bank_account.sensitive_change",
    module: "Finance",
    label: "Change bank account routing fields",
    description:
      "Modify the account number or routing number of an organization bank account. Silent changes can reroute outgoing payments and payroll.",
    entityType: "bank_account",
    subjectMode: "actor",
  },
];

export const SELF_ACTION_MODES = [
  {
    value: "block" as const,
    label: "Block",
    description: "Refuse self-approval. A different approver must act.",
  },
  {
    value: "require_cosign" as const,
    label: "Require co-signed override",
    description: "Block unless an owner has issued a one-time override.",
  },
  {
    value: "warn" as const,
    label: "Warn",
    description: "Allow but log a security event for review.",
  },
  {
    value: "allow" as const,
    label: "Allow",
    description: "Permit self-approval without restriction.",
  },
];

export type SelfActionMode = (typeof SELF_ACTION_MODES)[number]["value"];

/**
 * Human label for an entity type — used in picker placeholders and the
 * derived-subject hint in the Override dialog.
 */
export const ENTITY_TYPE_LABELS: Record<SelfActionEntityType, string> = {
  payroll_run: "payroll run",
  payroll_payment_batch: "payroll payment batch",
  leave_request: "leave request",
  timesheet_submission: "timesheet",
  employee_loan: "employee loan",
  employee_compensation_change: "compensation change",
  employee_contract: "employment contract",
  bill: "vendor bill",
  bill_payment: "bill payment",
  payment: "payment",
  journal_entry: "journal entry",
  customer_refund: "customer refund",
  purchase_requisition: "purchase requisition",
  rfq: "RFQ",
  purchase_order: "purchase order",
  vendor_credit_note: "vendor credit note",
  credit_note: "sales credit note",
  stock_adjustment: "stock adjustment",
  stock_transfer: "stock transfer",
  expense: "expense",
  bank_account: "bank account",
  payroll_run_loan_skip_override: "loan skip override",
};

/**
 * Wire-level entity_type value persisted to `self_action_overrides.entity_type`.
 * Matches the values the database triggers test against in `governance_assert_not_self`.
 */
export const ENTITY_TYPE_DB_KEY: Record<SelfActionEntityType, string> = {
  payroll_run: "payroll_run",
  payroll_payment_batch: "payroll_payment_batch",
  leave_request: "leave_request",
  timesheet_submission: "timesheet_submission",
  employee_loan: "employee_loan",
  employee_compensation_change: "employee_compensation_change",
  employee_contract: "employee_contract",
  bill: "bill",
  bill_payment: "bill_payment",
  payment: "payment",
  journal_entry: "journal_entry",
  customer_refund: "customer_refund",
  purchase_requisition: "purchase_requisition",
  rfq: "rfq",
  purchase_order: "purchase_order",
  vendor_credit_note: "vendor_credit_note",
  credit_note: "credit_note",
  stock_adjustment: "stock_adjustment",
  stock_transfer: "stock_transfer",
  expense: "expense",
  bank_account: "bank_account",
  payroll_run_loan_skip_override: "payroll_run_loan_skip_override",
};

/**
 * Reverse lookup — accepts the wire value that lands in
 * `audit_logs.entity_type` and returns the catalogue's entityType key.
 * Used by the Blocked-attempts queue to map a logged refusal back to
 * the right entity picker / record summary.
 */
export const DB_KEY_TO_ENTITY_TYPE: Record<string, SelfActionEntityType> = Object.fromEntries(
  (Object.entries(ENTITY_TYPE_DB_KEY) as [SelfActionEntityType, string][]).map(
    ([k, v]) => [v, k],
  ),
) as Record<string, SelfActionEntityType>;
