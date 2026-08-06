import { supabase } from "@/integrations/supabase/client";

/**
 * Canonical expense → GL settlement entrypoint.
 *
 * Account resolution (expense override → category mapping → operating expenses
 * default), input-tax splitting, payment-account selection, journal composition
 * and the link-back onto `expenses.journal_entry_id` all live server-side in
 * `public.post_expense_gl`, which posts through `post_journal_entry_atomic`.
 *
 * Per ADR 0123 (Single Journal Posting Monopoly) the browser must never compose
 * journal lines for expenses — call this function instead.
 */
export interface ExpenseGLPostingResult {
  journal_entry_id?: string | null;
  skipped?: boolean;
  reason?: string;
  idempotent_replay?: boolean;
}

export async function postExpenseGL(expenseId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("post_expense_gl" as any, {
    p_expense_id: expenseId,
  });

  if (error) {
    console.error("GL posting failed for expense:", error);
    throw new Error(`Expense saved but GL posting failed: ${error.message || "Unknown error"}`);
  }

  const result = (data ?? {}) as ExpenseGLPostingResult;

  if (result.skipped) {
    console.warn(`Expense GL posting skipped: ${result.reason ?? "unknown reason"}`);
    return null;
  }

  return result.journal_entry_id ?? null;
}
