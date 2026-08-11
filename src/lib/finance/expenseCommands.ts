import { supabase } from "@/integrations/supabase/client";
import {
  describeGovernanceError,
  parseGovernanceError,
} from "@/lib/governance/selfActionErrors";

/**
 * Canonical expense lifecycle commands.
 *
 * The browser NEVER writes `expenses.status`, `approved_by`, `approved_at`,
 * `journal_entry_id` or mints the linked vendor bill: column-level grants make
 * those writes impossible. Every state transition is a server command that
 * owns the whole business event — governance routing, SoD guards, GL posting
 * and audit trail happen inside one transaction.
 *
 *   draft ──submit──▶ submitted ──approve──▶ approved ──void──▶ voided
 *                        │  └─reject─▶ rejected ──submit──▶ submitted
 *                        └─(no governance rule) ─▶ approved (posted)
 *
 * See `public.expense_submit / expense_approve / expense_reject /
 * expense_void / expense_convert_to_bill`.
 */

export type ExpenseStatus =
  | "draft"
  | "pending"
  | "submitted"
  | "approved"
  | "rejected"
  | "paid"
  | "voided";

/** Statuses whose fields may still be edited by the capturer. */
export const EXPENSE_EDITABLE_STATUSES: ExpenseStatus[] = [
  "draft",
  "pending",
  "submitted",
  "rejected",
];

/** Statuses that may be hard-deleted (nothing has hit the ledger yet). */
export const EXPENSE_DELETABLE_STATUSES: ExpenseStatus[] = [
  "draft",
  "pending",
  "rejected",
];

export const isExpenseEditable = (status?: string | null) =>
  EXPENSE_EDITABLE_STATUSES.includes((status ?? "") as ExpenseStatus);

export const isExpenseDeletable = (status?: string | null) =>
  EXPENSE_DELETABLE_STATUSES.includes((status ?? "") as ExpenseStatus);

export interface ExpenseSubmitResult {
  success: boolean;
  status: ExpenseStatus;
  /** True when a governance rule intercepted the submission. */
  gated?: boolean;
  approval_request_id?: string | null;
  posting?: { journal_entry_id?: string | null; skipped?: boolean; reason?: string };
}

export interface ExpenseBillResult {
  bill_id: string;
  bill_number: string;
  idempotent_replay?: boolean;
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn as never, args as never);
  if (error) {
    // Diagnostics are never thrown away: the full Postgres envelope
    // (SQLSTATE, detail, hint) goes to the console so a 400 can always be
    // traced back to the failing server rule.
    console.error(`[expense] ${fn} failed`, {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    // Governance refusals (SoD, missing approver rights) carry structured hints.
    const gov = parseGovernanceError(error);
    if (gov) throw new Error(describeGovernanceError(gov).body);
    // Everything else keeps its Postgres shape so `normalizeError` can classify
    // it (business-rule P0001 messages are surfaced verbatim to the user).
    throw Object.assign(new Error(error.message || "Expense command failed"), {
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
  }
  return data as T;
}

export const submitExpense = (expenseId: string) =>
  call<ExpenseSubmitResult>("expense_submit", { p_expense_id: expenseId });

export const approveExpense = (expenseId: string) =>
  call<ExpenseSubmitResult>("expense_approve", { p_expense_id: expenseId });

export const rejectExpense = (expenseId: string, reason?: string | null) =>
  call<ExpenseSubmitResult>("expense_reject", {
    p_expense_id: expenseId,
    p_reason: reason ?? null,
  });

export const voidExpenseRpc = (expenseId: string, reason?: string | null) =>
  call<ExpenseSubmitResult>("expense_void", {
    p_expense_id: expenseId,
    p_reason: reason ?? null,
  });

export const convertExpenseToBill = (expenseId: string) =>
  call<ExpenseBillResult>("expense_convert_to_bill", { p_expense_id: expenseId });

/* ─────────────── Employee reimbursement settlement ───────────────
 * An employee-paid expense credits a dedicated employee payable at
 * approval. That obligation is discharged exactly once, through one
 * of two routes — never both:
 *
 *   payroll  → `expense_queue_payroll_reimbursement` flags the row;
 *              `compute-payroll` adds a non-taxable reimbursement
 *              earning and stamps `reimbursed_payslip_id/run_id/at`.
 *   direct   → `expense_reimburse_direct` posts payable → bank
 *              through the single journal engine (idempotent via
 *              `source_subtype='reimbursement'`) and marks it paid.
 *
 * The browser never writes any `reimburse*` column: those grants are
 * revoked from `authenticated`.
 */

export interface ExpenseReimbursementQueueResult {
  success: boolean;
  queued: boolean;
  employee_id?: string | null;
  idempotent_replay?: boolean;
}

export interface ExpenseReimbursementPaymentResult {
  success?: boolean;
  status?: ExpenseStatus;
  journal_entry_id?: string | null;
  payment_date?: string;
  idempotent_replay?: boolean;
}

/** True when this expense created an employee reimbursement obligation. */
export const isEmployeeReimbursable = (e: {
  status?: string | null;
  paid_by?: string | null;
  payment_method?: string | null;
  reimbursed_at?: string | null;
  reimbursed_payslip_id?: string | null;
}) =>
  ["approved", "paid"].includes((e.status ?? "") as string) &&
  (e.paid_by === "employee" || e.payment_method === "employee_reimbursement") &&
  !e.reimbursed_at &&
  !e.reimbursed_payslip_id;

/**
 * How the expenditure was (or will be) discharged. Derived from the
 * server-owned columns only — the browser never authors any of them, so
 * every surface that renders settlement reads the same truth.
 */
export type ExpenseSettlementRoute =
  | "company" // company cash/bank or card — nothing owed to anyone
  | "awaiting" // employee payable outstanding, no route chosen
  | "payroll_queued" // queued for the next payroll run
  | "payroll_paid" // discharged by payroll (payslip stamped)
  | "direct_paid" // discharged by a direct bank/cash payment
  | "not_applicable"; // pre-approval: no obligation exists yet

export interface ExpenseSettlementState {
  route: ExpenseSettlementRoute;
  label: string;
  detail: string;
  /** Reimbursement actions may be offered. */
  canSettle: boolean;
  /** Already queued for payroll — the action is "remove from queue". */
  queued: boolean;
}

export const describeExpenseSettlement = (e: {
  status?: string | null;
  paid_by?: string | null;
  payment_method?: string | null;
  reimburse_via_payroll?: boolean | null;
  reimbursed_at?: string | null;
  reimbursed_payslip_id?: string | null;
  reimbursed_run_id?: string | null;
}): ExpenseSettlementState => {
  const employeePaid =
    e.paid_by === "employee" || e.payment_method === "employee_reimbursement";

  if (!employeePaid) {
    return {
      route: "company",
      label: "Settled by the company",
      detail:
        e.paid_by === "company_card"
          ? "Funded on a company card — the card liability is cleared through card reconciliation."
          : "Funded from company cash or bank at capture, so nobody is owed a reimbursement.",
      canSettle: false,
      queued: false,
    };
  }

  if (e.reimbursed_payslip_id || e.reimbursed_run_id) {
    return {
      route: "payroll_paid",
      label: "Reimbursed through payroll",
      detail:
        "Paid as a non-taxable reimbursement on the employee's payslip; the payable is cleared.",
      canSettle: false,
      queued: false,
    };
  }

  if (e.reimbursed_at) {
    return {
      route: "direct_paid",
      label: "Reimbursed by direct payment",
      detail:
        "Paid to the employee from a bank or cash account; the employee payable is cleared.",
      canSettle: false,
      queued: false,
    };
  }

  if (!["approved", "paid"].includes((e.status ?? "") as string)) {
    return {
      route: "not_applicable",
      label: "No obligation yet",
      detail:
        "An employee payable is created when the expense is approved and posted.",
      canSettle: false,
      queued: false,
    };
  }

  if (e.reimburse_via_payroll) {
    return {
      route: "payroll_queued",
      label: "Queued for payroll reimbursement",
      detail:
        "The next payroll run will pay this as a non-taxable reimbursement earning.",
      canSettle: true,
      queued: true,
    };
  }

  return {
    route: "awaiting",
    label: "Awaiting reimbursement",
    detail:
      "The employee is owed this amount. Discharge it through payroll or a direct payment.",
    canSettle: true,
    queued: false,
  };
};



export const queueExpensePayrollReimbursement = (
  expenseId: string,
  employeeId?: string | null,
) =>
  call<ExpenseReimbursementQueueResult>("expense_queue_payroll_reimbursement", {
    p_expense_id: expenseId,
    p_employee_id: employeeId ?? null,
  });

export const unqueueExpensePayrollReimbursement = (expenseId: string) =>
  call<ExpenseReimbursementQueueResult>(
    "expense_unqueue_payroll_reimbursement",
    { p_expense_id: expenseId },
  );

export const reimburseExpenseDirect = (
  expenseId: string,
  bankAccountId: string,
  paymentDate?: string | null,
  reference?: string | null,
) =>
  call<ExpenseReimbursementPaymentResult>("expense_reimburse_direct", {
    p_expense_id: expenseId,
    p_bank_account_id: bankAccountId,
    p_payment_date: paymentDate ?? null,
    p_reference: reference ?? null,
  });

