/**
 * Consolidated trial balance (Brick 2 — group aggregation on the authoritative engine).
 *
 * These hooks own NO accounting arithmetic. Every figure is produced by
 * `get_consolidated_trial_balance`, which itself reads only
 * `get_ledger_opening_balances` and `get_account_movements` — the same posted-GL
 * engine behind the Trial Balance, P&L and Balance Sheet. Aggregation, scope
 * resolution and authorization all happen server-side so a browser can neither
 * widen the scope nor invent a balance.
 *
 * Refusal over approximation: the RPC raises instead of returning partial truth
 * when the caller cannot access every member company, when a member reports in a
 * currency other than the group's presentation currency (FX translation is
 * Brick 3), or when a member uses the equity method (Brick 3+). The UI surfaces
 * that refusal verbatim rather than rendering a number nobody can defend.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { ConsolidationMethod } from "./useConsolidationGroups";

export interface ConsolidationScopeMember {
  group_id: string;
  group_name: string;
  presentation_currency: string;
  business_id: string;
  business_name: string;
  base_currency: string | null;
  is_parent: boolean;
  method: ConsolidationMethod;
  ownership_percent: number | null;
  effective_from: string;
  effective_to: string | null;
  /** Non-null when this member makes an honest consolidation impossible today. */
  blocker: string | null;
}

export interface ConsolidatedTrialBalanceRow {
  business_id: string;
  business_name: string;
  is_parent: boolean;
  ownership_percent: number | null;
  account_id: string;
  account_code: string | null;
  account_name: string;
  account_type: string;
  is_nominal: boolean;
  opening_balance: number;
  total_debit: number;
  total_credit: number;
  closing_balance: number;
}

/** Plain-English explanation of a server-reported scope blocker. */
export const CONSOLIDATION_BLOCKER_LABELS: Record<string, string> = {
  equity_method_not_supported_yet:
    "A member company uses the equity method. Equity accounting needs acquisition and post-acquisition data that is not captured yet, so its balances are not aggregated.",
  currency_translation_required:
    "A member company keeps its books in a different currency from the group's presentation currency. Translating it requires the FX translation and CTA engine, which is not built yet.",
  member_has_no_base_currency:
    "A member company has no base currency set, so its balances cannot be safely combined.",
  ownership_percent_missing:
    "A member company has no ownership percentage recorded, so its share of the group cannot be established.",
};

export function describeConsolidationBlocker(blocker: string): string {
  return CONSOLIDATION_BLOCKER_LABELS[blocker] ?? blocker;
}

/**
 * Who is in the group as of a date, and what (if anything) blocks aggregation.
 * Membership is effective-dated, so the answer is a function of the date.
 */
export function useConsolidationScope(groupId: string | null, asOf: string | null) {
  return useQuery({
    queryKey: ["consolidation-scope", groupId, asOf],
    enabled: !!groupId && !!asOf,
    queryFn: async (): Promise<ConsolidationScopeMember[]> => {
      const { data, error } = await supabase.rpc("resolve_consolidation_scope", {
        _group_id: groupId!,
        _as_of: asOf!,
      });
      if (error) throw error;
      return (data ?? []) as ConsolidationScopeMember[];
    },
  });
}

/**
 * Per-member, per-account opening / movement / closing balances for the group.
 * Rows stay traceable to the company they came from: nothing is pre-summed, so
 * a reviewer can always drill from the group figure back to a member's ledger.
 */
export function useConsolidatedTrialBalance(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidated-trial-balance", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: async (): Promise<ConsolidatedTrialBalanceRow[]> => {
      const { data, error } = await supabase.rpc("get_consolidated_trial_balance", {
        _group_id: groupId!,
        _date_from: dateFrom!,
        _date_to: dateTo!,
      });
      if (error) throw error;
      return (data ?? []) as ConsolidatedTrialBalanceRow[];
    },
  });
}

/** One consolidated line per account, with the member contributions kept. */
export interface ConsolidatedAccountLine {
  account_id: string;
  account_code: string | null;
  account_name: string;
  account_type: string;
  opening_balance: number;
  total_debit: number;
  total_credit: number;
  closing_balance: number;
  contributions: ConsolidatedTrialBalanceRow[];
}

/**
 * Combine member rows by account. Full-consolidation members contribute 100 %
 * of their balances (IFRS 10 / ASC 810 control model); the non-controlling
 * share is *disclosed*, never netted off, so this stays a pure regrouping of
 * the server's figures.
 */
export function groupTrialBalanceByAccount(
  rows: ConsolidatedTrialBalanceRow[],
): ConsolidatedAccountLine[] {
  const byAccount = new Map<string, ConsolidatedAccountLine>();

  for (const row of rows) {
    const existing = byAccount.get(row.account_id);
    if (existing) {
      existing.opening_balance += Number(row.opening_balance);
      existing.total_debit += Number(row.total_debit);
      existing.total_credit += Number(row.total_credit);
      existing.closing_balance += Number(row.closing_balance);
      existing.contributions.push(row);
      continue;
    }
    byAccount.set(row.account_id, {
      account_id: row.account_id,
      account_code: row.account_code,
      account_name: row.account_name,
      account_type: row.account_type,
      opening_balance: Number(row.opening_balance),
      total_debit: Number(row.total_debit),
      total_credit: Number(row.total_credit),
      closing_balance: Number(row.closing_balance),
      contributions: [row],
    });
  }

  return Array.from(byAccount.values()).sort((a, b) =>
    (a.account_code ?? "").localeCompare(b.account_code ?? ""),
  );
}

/**
 * Non-controlling interest disclosure: the minority share of each member's
 * period result is reported separately instead of being blended into the group
 * figures. This only re-presents server-provided balances.
 */
export function nonControllingShare(row: ConsolidatedTrialBalanceRow): number {
  const owned = Number(row.ownership_percent ?? 100);
  const minority = Math.max(0, 100 - owned) / 100;
  return Number(row.closing_balance) * minority;
}
