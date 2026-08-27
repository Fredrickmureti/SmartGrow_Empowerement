/**
 * Consolidated income statement and balance sheet (Brick 5).
 *
 * These hooks own NO accounting arithmetic — not even the totals. Every figure
 * comes from `get_consolidated_statement_lines` and
 * `get_consolidated_statement_totals`, which are themselves projections of the
 * translated consolidated trial balance. That is deliberate: the statements
 * can never disagree with the trial balance they were built from, and a period
 * the consolidation engine refuses is refused here too rather than rendered as
 * a plausible-looking number.
 *
 * The balance sheet carries the year-to-date result as its own line, because
 * that result is not posted to equity until the year closes; without it assets
 * would not equal liabilities plus equity.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/supabaseError";

export type ConsolidatedStatement = "income_statement" | "balance_sheet";

export type ConsolidatedStatementSection =
  | "income"
  | "expense"
  | "asset"
  | "liability"
  | "equity";

export interface ConsolidatedStatementLine {
  statement: ConsolidatedStatement;
  section: ConsolidatedStatementSection;
  section_order: number;
  /** Null on derived lines, which correspond to no single ledger account. */
  account_id: string | null;
  account_code: string | null;
  account_name: string;
  account_type: string;
  /** The currency translation reserve, emitted by the engine as a residual. */
  is_residual: boolean;
  /** True for the result-of-the-period line the balance sheet needs to balance. */
  is_derived: boolean;
  presentation_currency: string;
  amount: number;
}

export interface ConsolidatedStatementTotals {
  presentation_currency: string;
  total_income: number;
  total_expense: number;
  net_result: number;
  total_assets: number;
  total_liabilities: number;
  total_equity: number;
  translation_reserve: number;
  balance_difference: number;
  is_balanced: boolean;
}

export const CONSOLIDATED_SECTION_LABELS: Record<ConsolidatedStatementSection, string> = {
  income: "Income",
  expense: "Expenses",
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
};

/** Statement lines for a group and period, in the presentation currency. */
export function useConsolidatedStatementLines(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidated-statement-lines", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: async (): Promise<ConsolidatedStatementLine[]> => {
      const { data, error } = await supabase.rpc("get_consolidated_statement_lines", {
        _group_id: groupId!,
        _date_from: dateFrom!,
        _date_to: dateTo!,
      });
      if (error) throw toAppError(error);
      return (data ?? []) as ConsolidatedStatementLine[];
    },
  });
}

/**
 * Group totals, including the server's own verdict on whether the balance
 * sheet balances. The UI reports that verdict; it never decides it.
 */
export function useConsolidatedStatementTotals(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidated-statement-totals", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: async (): Promise<ConsolidatedStatementTotals | null> => {
      const { data, error } = await supabase.rpc("get_consolidated_statement_totals", {
        _group_id: groupId!,
        _date_from: dateFrom!,
        _date_to: dateTo!,
      });
      if (error) throw toAppError(error);
      const rows = (data ?? []) as ConsolidatedStatementTotals[];
      return rows[0] ?? null;
    },
  });
}

/**
 * Lines of one statement, in the server's order, grouped by section.
 *
 * Generic in the line shape so richer rows — the eliminated projection's
 * aggregated / elimination / consolidated columns — survive the grouping
 * instead of being narrowed back to the aggregated-only line.
 */
export function sectionsOf<T extends ConsolidatedStatementLine>(
  lines: T[],
  statement: ConsolidatedStatement,
): { section: ConsolidatedStatementSection; lines: T[] }[] {
  const out: { section: ConsolidatedStatementSection; lines: T[] }[] = [];
  for (const line of lines) {
    if (line.statement !== statement) continue;
    const last = out[out.length - 1];
    if (last && last.section === line.section) last.lines.push(line);
    else out.push({ section: line.section, lines: [line] });
  }
  return out;
}
