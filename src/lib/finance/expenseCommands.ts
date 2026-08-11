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
    // Governance refusals (SoD, missing approver rights) carry structured hints.
    const gov = parseGovernanceError(error);
    if (gov) throw new Error(describeGovernanceError(gov).body);
    throw new Error(error.message || "Expense command failed");
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
