/**
 * Consolidated trial balance (Brick 2 + Brick 3 — group aggregation and
 * currency translation on the authoritative engine).
 *
 * These hooks own NO accounting arithmetic. Every figure is produced by
 * `get_consolidated_trial_balance_translated`, which reads only the posted-GL
 * engine (`get_ledger_opening_balances`, `get_account_movements`,
 * `get_gl_transactions`) and restates each member into the group's
 * presentation currency under IAS 21: closing rate for assets and liabilities,
 * transaction-date rates for equity, average rate for income and expense. The
 * residual of that restatement is emitted as its own line against the group's
 * translation reserve account — never spread across the figures it came from.
 *
 * Refusal over approximation: the RPC raises instead of returning partial
 * truth when the caller cannot access every member company, when a member uses
 * the equity method, when a foreign member's group has no translation reserve
 * account configured, or when the exchange rate history does not cover the
 * period. The UI surfaces that refusal verbatim rather than rendering a number
 * nobody can defend.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toAppError } from "@/lib/supabaseError";
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
  /** True when this member's books are kept in another currency. */
  requires_translation: boolean;
  /** Non-null when this member makes an honest consolidation impossible. */
  blocker: string | null;
}

/**
 * How a line was translated. `residual` marks the translation reserve line the
 * engine emits itself — it is the balancing figure, not a posted balance.
 */
export type TranslationRateClass =
  | "closing"
  | "transaction"
  | "average"
  | "residual";

export interface ConsolidatedTrialBalanceRow {
  business_id: string;
  business_name: string;
  is_parent: boolean;
  ownership_percent: number | null;
  base_currency: string | null;
  presentation_currency: string;
  account_id: string;
  account_code: string | null;
  account_name: string;
  account_type: string;
  /**
   * The group account this member account resolves to (Brick 4). Null only for
   * the engine's own translation-reserve residual line, which belongs to the
   * group rather than to any member's chart.
   */
  group_account_id: string | null;
  group_account_code: string | null;
  group_account_name: string | null;
  /** False when the line is reported under its member account for want of a mapping. */
  is_mapped: boolean;
  is_nominal: boolean;
  rate_class: TranslationRateClass;
  rate_used: number | null;
  /** Figures as posted in the member's own currency. */
  opening_balance: number;
  total_debit: number;
  total_credit: number;
  closing_balance: number;
  /** The same figures restated into the group's presentation currency. */
  translated_opening: number;
  translated_debit: number;
  translated_credit: number;
  translated_closing: number;
}


/** Per-member proof that the translation reserve is what it should be. */
export interface ConsolidationCtaRow {
  business_id: string;
  business_name: string;
  base_currency: string | null;
  presentation_currency: string;
  opening_rate: number | null;
  closing_rate: number | null;
  average_rate: number | null;
  historical_rate: number | null;
  opening_cta: number;
  cta_movement: number;
  closing_cta: number;
  opening_net_assets: number;
  period_result: number;
  equity_movement: number;
  expected_from_opening_net_assets: number;
  expected_from_result: number;
  expected_from_equity_movements: number;
  expected_cta_movement: number;
  movement_difference: number;
  is_reconciled: boolean;
}

/** Plain-English explanation of a server-reported scope blocker. */
export const CONSOLIDATION_BLOCKER_LABELS: Record<string, string> = {
  equity_method_not_supported_yet:
    "A member company uses the equity method. Equity accounting needs acquisition and post-acquisition data that is not captured yet, so its balances are not aggregated.",
  member_has_no_base_currency:
    "A member company has no base currency set, so its balances cannot be safely combined.",
  ownership_percent_missing:
    "A member company has no ownership percentage recorded, so its share of the group cannot be established.",
  cta_account_not_configured:
    "A member company keeps its books in another currency, but this group has no translation reserve account. Choose one under Finance → Settings → Consolidation groups; without it the translation difference would have nowhere to go and the report would not balance.",
  insufficient_rate_coverage:
    "The exchange rate history does not cover this period for a member company kept in another currency. Record the missing rates; translating on a guessed rate would misstate every figure it touches.",

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
      if (error) throw toAppError(error);
      return (data ?? []) as ConsolidationScopeMember[];
    },
  });
}

/**
 * Per-member, per-account balances for the group, restated into the group's
 * presentation currency. Rows stay traceable to the company and the rate they
 * came from: nothing is pre-summed, so a reviewer can always drill from the
 * group figure back to a member's own ledger in its own currency.
 */
export function useConsolidatedTrialBalance(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidated-trial-balance-translated", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: async (): Promise<ConsolidatedTrialBalanceRow[]> => {
      const { data, error } = await supabase.rpc(
        "get_consolidated_trial_balance_translated",
        { _group_id: groupId!, _date_from: dateFrom!, _date_to: dateTo! },
      );
      if (error) throw toAppError(error);
      return (data ?? []) as ConsolidatedTrialBalanceRow[];
    },
  });
}

/**
 * The translation reserve, proved independently: the engine's residual is
 * compared against what the movement in the reserve *should* be, built from
 * opening net assets, the period result and dated equity movements. A member
 * that does not reconcile is a defect to surface, never to hide.
 */
export function useConsolidationCtaReconciliation(
  groupId: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  return useQuery({
    queryKey: ["consolidation-cta-reconciliation", groupId, dateFrom, dateTo],
    enabled: !!groupId && !!dateFrom && !!dateTo,
    queryFn: async (): Promise<ConsolidationCtaRow[]> => {
      const { data, error } = await supabase.rpc("consolidation_cta_reconciliation", {
        _group_id: groupId!,
        _date_from: dateFrom!,
        _date_to: dateTo!,
      });
      if (error) throw toAppError(error);
      return (data ?? []) as ConsolidationCtaRow[];
    },
  });
}

/**
 * One consolidated line per *group* account, with the member contributions
 * kept underneath it for drill-down.
 */
export interface ConsolidatedAccountLine {
  /** Group account id, or the member account id when nothing maps it yet. */
  account_id: string;
  account_code: string | null;
  account_name: string;
  account_type: string;
  is_residual: boolean;
  /** False when this line is a member account reported for want of a mapping. */
  is_mapped: boolean;
  opening_balance: number;
  total_debit: number;
  total_credit: number;
  closing_balance: number;
  contributions: ConsolidatedTrialBalanceRow[];
}

/**
 * Combine member rows by *group* account, in the group's presentation currency.
 * The group chart is what makes this a consolidation rather than a stack of
 * member ledgers: the same economic account in two companies lands on one line.
 *
 * Full-consolidation members contribute 100 % of their balances (IFRS 10 /
 * ASC 810 control model); the non-controlling share is *disclosed*, never
 * netted off, so this stays a pure regrouping of the server's figures.
 *
 * Rows the server could not resolve to a group account keep their member
 * identity instead of being merged on a guess — and are flagged unmapped, so a
 * reviewer sees exactly which balances still lack a group account.
 */
export function groupTrialBalanceByAccount(
  rows: ConsolidatedTrialBalanceRow[],
): ConsolidatedAccountLine[] {
  const byAccount = new Map<string, ConsolidatedAccountLine>();

  for (const row of rows) {
    const mapped = row.is_mapped && !!row.group_account_id;
    // Unmapped member accounts are keyed per company: two companies' accounts
    // may share a code without being the same account.
    const key = mapped ? row.group_account_id! : `member:${row.business_id}:${row.account_id}`;
    const existing = byAccount.get(key);
    if (existing) {
      existing.opening_balance += Number(row.translated_opening);
      existing.total_debit += Number(row.translated_debit);
      existing.total_credit += Number(row.translated_credit);
      existing.closing_balance += Number(row.translated_closing);
      existing.is_residual = existing.is_residual || row.rate_class === "residual";
      existing.contributions.push(row);
      continue;
    }
    byAccount.set(key, {
      account_id: mapped ? row.group_account_id! : row.account_id,
      account_code: mapped ? row.group_account_code : row.account_code,
      account_name: mapped ? (row.group_account_name ?? row.account_name) : row.account_name,
      account_type: row.account_type,
      is_residual: row.rate_class === "residual",
      is_mapped: mapped,
      opening_balance: Number(row.translated_opening),
      total_debit: Number(row.translated_debit),
      total_credit: Number(row.translated_credit),
      closing_balance: Number(row.translated_closing),
      contributions: [row],
    });
  }

  return Array.from(byAccount.values()).sort((a, b) =>
    (a.account_code ?? "").localeCompare(b.account_code ?? ""),
  );
}


/** Asset and expense balances sit on the debit side; everything else credits. */
const DEBIT_NORMAL_ACCOUNT_TYPES = new Set(["asset", "expense"]);

export function isDebitNormalAccountType(accountType: string | null): boolean {
  return DEBIT_NORMAL_ACCOUNT_TYPES.has((accountType ?? "").trim().toLowerCase());
}

/** The two sides of the accounting equation, proved on closing balances. */
export interface TrialBalanceProof {
  /** Assets and expenses, at their translated closing balances. */
  debitSide: number;
  /** Liabilities, equity (incl. the translation reserve) and income. */
  creditSide: number;
  difference: number;
  isBalanced: boolean;
}

/**
 * Prove a translated group trial balance the only way it *can* be proved: on
 * closing balances.
 *
 * The period movement columns cannot prove a consolidation. Members translate
 * their movements at the average rate while their balance-sheet closing
 * balances translate at the closing rate, and the engine's translation-reserve
 * line is a closing-balance residual with no movement of its own. Summing the
 * debit and credit *movement* columns therefore reports an out-of-balance in
 * any group with a foreign member whose books are perfectly in order — which
 * is a false alarm on an artifact accountants rely on.
 *
 * `consolidation_translate_member` emits the reserve as exactly the residual
 * that makes the debit and credit sides of the closing balances agree, so a
 * correctly translated group proves to zero here to the cent.
 */
export function proveTrialBalanceOnClosingBalances(
  lines: Pick<ConsolidatedAccountLine, "account_type" | "closing_balance">[],
): TrialBalanceProof {
  let debitSide = 0;
  let creditSide = 0;
  for (const line of lines) {
    if (isDebitNormalAccountType(line.account_type)) debitSide += Number(line.closing_balance);
    else creditSide += Number(line.closing_balance);
  }
  const difference = debitSide - creditSide;
  return { debitSide, creditSide, difference, isBalanced: Math.abs(difference) < 0.005 };
}

/**
 * Non-controlling interest disclosure: the minority share of each member's
 * period result is reported separately instead of being blended into the group
 * figures. This only re-presents server-provided, already translated balances.
 */
export function nonControllingShare(row: ConsolidatedTrialBalanceRow): number {
  const owned = Number(row.ownership_percent ?? 100);
  const minority = Math.max(0, 100 - owned) / 100;
  return Number(row.translated_closing) * minority;
}
