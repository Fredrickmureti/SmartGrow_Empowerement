import type { Database } from "@/integrations/supabase/types";

/**
 * Which journal sources consume a budget.
 *
 * A budget measures *operating* activity for a period. Entries that merely
 * establish or roll forward balances are not spending: warning about them
 * would fire a false budget breach every time a tenant is onboarded, migrated
 * or closes its year. This list is the single place that decision lives — the
 * posting-time warning (`useGLPosting`) reads it, and no other module may
 * hard-code its own exclusions.
 *
 * Note this governs the *warning* only. Which ledger rows count as actuals is
 * decided server-side by the budget variance report; React never re-derives it.
 */
export type GLSourceType = string;

export const NON_OPERATIONAL_JOURNAL_SOURCES: ReadonlySet<GLSourceType> = new Set([
  // Year-end roll-forward: closes P&L into equity, not new spending.
  "year_end_closing",
  // Establishes the tenant's starting balance sheet.
  "opening_balance",
  // Historical data brought in from a previous system.
  "migration",
  // Unwinds an entry that already had its chance to breach the budget.
  "reversal",
]);

/** True when a posting should be measured against the active budget. */
export function consumesBudget(sourceType: GLSourceType): boolean {
  return !NON_OPERATIONAL_JOURNAL_SOURCES.has(sourceType);
}

export type JournalSourceType = Database["public"]["Tables"]["journal_entries"]["Row"]["source_type"];
