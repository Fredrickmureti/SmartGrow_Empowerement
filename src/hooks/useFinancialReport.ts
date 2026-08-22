/**
 * Universal Financial Report Engine Hook
 * 
 * Generates all financial statements (P&L, Balance Sheet, Trial Balance)
 * directly from journal_entry_lines + accounts (General Ledger).
 * This is the single source of truth for all financial reporting.
 * 
 * Key principles:
 * - All data comes from posted journal entries only
 * - Accrual-based: entries are recognized when posted, not when paid
 * - Date-aware: opening balances calculated from prior periods
 * - Hierarchy-aware: supports parent/child account grouping
 * - Organization-scoped: always filters by org and optionally by business
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import {
  type AccountNode,
  buildAccountHierarchy,
  calculateBalance,
  isDebitNormal,
  groupByAccountType,
  ACCOUNT_TYPE_LABELS,
  validateBalanceSheet,
} from "@/services/reports/ReportCalculationEngine";

// ─── Types ───────────────────────────────────────────────────────────

export type ReportType = "pnl" | "balance_sheet" | "trial_balance";

export interface FinancialReportParams {
  /** Type of financial report */
  reportType: ReportType;
  /** Start of reporting period (for P&L) or ignored for Balance Sheet */
  dateFrom: string;
  /** End of reporting period (for P&L) or "as of" date for Balance Sheet */
  dateTo: string;
  /** Filter to specific accounts */
  accountIds?: string[];
  /** Filter to specific account types */
  accountTypes?: Array<"asset" | "liability" | "equity" | "income" | "expense">;
  /** Include accounts with zero balance/activity */
  includeZeroActivity?: boolean;
  /** Comparison period start (for period comparison) */
  comparisonDateFrom?: string;
  /** Comparison period end */
  comparisonDateTo?: string;
  /**
   * Optional branch dimension filter. NULL/undefined = all branches
   * (company-wide). When set, all RPC calls filter posted JEs by branch.
   */
  branchId?: string | null;
}

export interface FinancialReportAccount {
  id: string;
  code: string;
  name: string;
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
  detail_type: string | null;
  parent_id: string | null;
  opening_balance: number;
  debit_total: number;
  credit_total: number;
  closing_balance: number;
  /** For P&L: the display amount (income: credit - debit, expense: debit - credit) */
  display_amount: number;
  /**
   * Group rows only: this account's own amount PLUS every descendant's.
   * Presentation-only — section totals never read it (they sum own amounts),
   * so it can never double-count.
   */
  rollup_amount?: number;

  /** Comparison period amount (if requested) */
  comparison_amount?: number;
  /** Variance from comparison period */
  variance?: number;
  /** Variance percentage */
  variance_percent?: number | null;
  /** Hierarchy depth for indentation */
  depth: number;
  /** Whether this is a group/parent account */
  is_group: boolean;
  /** Children accounts */
  children: FinancialReportAccount[];
}

export interface FinancialReportData {
  /** Report type */
  reportType: ReportType;
  /** Reporting period */
  dateRange: { from: string; to: string };
  /** All accounts with calculated balances */
  accounts: FinancialReportAccount[];
  /** Accounts grouped by type */
  sections: Record<string, FinancialReportAccount[]>;
  /** Section totals */
  sectionTotals: Record<string, number>;
  /** Grand totals */
  totals: {
    totalDebits: number;
    totalCredits: number;
    /** For P&L: Net Income. For BS: should equal zero (A = L + E) */
    netAmount: number;
  };
  /** Trial balance specific */
  isBalanced?: boolean;
  /** P&L specific */
  netIncome?: number;
  /** Balance Sheet specific: total assets, total liabilities, total equity */
  balanceSheetTotals?: {
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
    /** @deprecated alias of currentYearEarnings, kept for existing callers */
    retainedEarnings: number;
    /** Result of the CURRENT fiscal year only (SQL-derived). */
    currentYearEarnings: number;
    /** Accumulated result of every closed fiscal year (already inside equity accounts). */
    priorYearsResult: number;
    fiscalYearStart: string | null;
    /** False when no retained-earnings account resolves — prior-year result would be dropped. */
    hasRetainedEarningsAccount: boolean;
  };

  /** Validation warnings and errors (especially for balance sheet integrity) */
  validationWarnings?: string[];
  /**
   * Set when no company is in context for an org with >1 company.
   * Cross-company financial statements require a consolidation engine
   * (intercompany eliminations, currency translation) — see /reports/consolidation.
   * Until then, callers MUST surface a "select a company" message instead of
   * rendering misleading summed numbers.
   */
  requiresConsolidation?: boolean;
}

// ─── Fetcher Functions ───────────────────────────────────────────────

/**
 * Fetch active accounts for reporting.
 * `accounts.business_id` is NOT NULL, so the scope is strict equality — the
 * same rule `get_general_ledger` and the server-side PDF engine apply. A
 * looser `business_id IS NULL` leg would make the screen and the exported
 * document disagree about which accounts are in scope.
 */
async function fetchAccounts(
  orgId: string,
  businessId: string | undefined,
  accountTypes?: Array<"asset" | "liability" | "equity" | "income" | "expense">,
  accountIds?: string[]
) {
  let query = supabase
    .from("accounts")
    .select("id, code, name, account_type, detail_type, opening_balance, parent_id, is_active")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .order("code");

  if (businessId) {
    query = query.eq("business_id", businessId);
  }


  if (accountTypes && accountTypes.length > 0) {
    query = query.in("account_type", accountTypes);
  }

  if (accountIds && accountIds.length > 0) {
    query = query.in("id", accountIds);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Fetch aggregated account movements via server-side RPC.
 * Eliminates the 1000-row Supabase limit risk.
 */
async function fetchMovementsRPC(
  orgId: string,
  dateFrom: string,
  dateTo: string,
  businessId?: string,
  branchId?: string | null
): Promise<Map<string, { debit: number; credit: number }>> {
  const { data, error } = await supabase.rpc("get_account_movements", {
    _org_id: orgId,
    _date_from: dateFrom,
    _date_to: dateTo,
    _business_id: businessId || null,
    _branch_id: branchId || null,
  });
  if (error) throw error;
  return rpcToMap(data || []);
}

/**
 * Opening position per account, as of the first day of the period.
 *
 * Opening balances are accounting output and are owned by SQL
 * (`get_ledger_opening_balances`), not by this hook. The engine applies the
 * fiscal-year boundary — income and expense accounts restart at the start of
 * the financial year and the prior years' result is folded into retained
 * earnings, so opening debits still equal opening credits — and suppresses
 * the business-level `accounts.opening_balance` on a branch-scoped run.
 */
async function fetchOpeningBalancesRPC(
  orgId: string,
  periodStart: string,
  businessId?: string,
  branchId?: string | null
): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc("get_ledger_opening_balances", {
    _org_id: orgId,
    _business_id: businessId || null,
    _as_of: periodStart,
    _branch_id: branchId || null,
  });
  if (error) throw error;
  const map = new Map<string, number>();
  for (const row of (data || []) as Array<{ account_id: string; opening_balance: number | string }>) {
    map.set(row.account_id, Number(row.opening_balance) || 0);
  }
  return map;
}

function rpcToMap(rows: any[]): Map<string, { debit: number; credit: number }> {
  const map = new Map<string, { debit: number; credit: number }>();
  for (const r of rows) {
    map.set(r.account_id, {
      debit: Number(r.total_debit) || 0,
      credit: Number(r.total_credit) || 0,
    });
  }
  return map;
}

// ─── Main Hook ───────────────────────────────────────────────────────

export function useFinancialReport(params: FinancialReportParams) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: [
      "financial-report",
      params.reportType,
      currentOrg?.id,
      currentBusiness?.id,
      params.dateFrom,
      params.dateTo,
      params.accountIds,
      params.accountTypes,
      params.includeZeroActivity,
      params.comparisonDateFrom,
      params.comparisonDateTo,
      params.branchId ?? null,
    ],
    queryFn: async (): Promise<FinancialReportData> => {
      if (!currentOrg?.id) {
        return emptyReport(params);
      }

      const orgId = currentOrg.id;
      const businessId = currentBusiness?.id;

      // Consolidation gate (Phase 7 decision #4):
      // When no company is selected AND the workspace actually has more than
      // one company, refuse to render a financial statement. Summing
      // non-consolidated ledgers without intercompany eliminations produces
      // materially wrong financials. See /reports/consolidation.
      if (!businessId) {
        const { count } = await supabase
          .from("businesses")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("is_active", true);
        if ((count ?? 0) > 1) {
          return { ...emptyReport(params), requiresConsolidation: true };
        }
      }

      // ── Balance-sheet reporting window ──────────────────────────────
      //
      // A Balance Sheet is cumulative, so the page asks for an epoch start
      // (1970-01-01). Reading opening balances AT that epoch, however,
      // defeats the retained-earnings fold that
      // `get_ledger_opening_balances` performs: the RPC derives the fiscal
      // year from its own `_as_of`, so an epoch `_as_of` produces a 1970
      // fiscal year and folds NOTHING into retained earnings. Every closed
      // year's result then existed in no balance-sheet account at all and
      // the statement could not balance.
      //
      // Fix: resolve the fiscal year from SQL (`get_equity_result`, the one
      // retained-earnings authority) and read the opening position AT the
      // fiscal-year start, with movement over the current fiscal year. The
      // arithmetic is identical for every other account — opening as of the
      // FY start already contains all prior movement — but the retained
      // earnings account now carries the closed years' result, exactly as it
      // does on the server-side PDF path (which always passed a real
      // period start and therefore never had this defect).
      let equityResult:
        | {
            fiscal_year_start?: string | null;
            current_year_earnings?: number;
            prior_years_result?: number;
            retained_earnings_account_id?: string | null;
          }
        | undefined;
      let effectiveDateFrom = params.dateFrom;
      if (params.reportType === "balance_sheet") {
        const { data: equityRows, error: equityError } = await supabase.rpc("get_equity_result", {
          _org_id: orgId,
          _business_id: businessId ?? null,
          _as_of: params.dateTo,
          _branch_id: params.branchId ?? null,
        });
        if (equityError) throw equityError;
        equityResult = (Array.isArray(equityRows) ? equityRows[0] : equityRows) ?? undefined;
        if (equityResult?.fiscal_year_start) {
          effectiveDateFrom = equityResult.fiscal_year_start;
        }
      }

      // Determine which account types to fetch based on report type
      let accountTypes: Array<"asset" | "liability" | "equity" | "income" | "expense"> | undefined = params.accountTypes;
      if (!accountTypes) {
        switch (params.reportType) {
          case "pnl":
            accountTypes = ["income", "expense"];
            break;
          case "balance_sheet":
            accountTypes = ["asset", "liability", "equity"];
            break;
          // trial_balance: all types
        }
      }

      // Fetch accounts and movements in parallel (using server-side RPC)
      const [accounts, periodByAccount, openingByAccount] = await Promise.all([
        fetchAccounts(orgId, businessId, accountTypes, params.accountIds),
        fetchMovementsRPC(orgId, effectiveDateFrom, params.dateTo, businessId, params.branchId),
        fetchOpeningBalancesRPC(orgId, effectiveDateFrom, businessId, params.branchId),
      ]);


      // Fetch comparison period if requested
      let comparisonMovements: Map<string, { debit: number; credit: number }> | null = null;
      let comparisonOpenings: Map<string, number> | null = null;
      if (params.comparisonDateFrom && params.comparisonDateTo) {
        const [compMov, compOpening] = await Promise.all([
          fetchMovementsRPC(orgId, params.comparisonDateFrom, params.comparisonDateTo, businessId, params.branchId),
          fetchOpeningBalancesRPC(orgId, params.comparisonDateFrom, businessId, params.branchId),
        ]);
        comparisonMovements = compMov;
        comparisonOpenings = compOpening;
      }

      // Build report accounts
      const reportAccounts: FinancialReportAccount[] = [];
      let totalDebits = 0;
      let totalCredits = 0;

      for (const account of accounts) {
        const period = periodByAccount.get(account.id) || { debit: 0, credit: 0 };
        // Server-owned opening position (fiscal-year aware, branch aware).
        const openingBalance = openingByAccount.get(account.id) ?? 0;

        // Skip zero-activity accounts unless requested: no movement in the
        // period AND nothing carried in. The opening figure already contains
        // `accounts.opening_balance` and prior activity, so it is the single
        // thing to test — matches the server engine and the PDF.
        if (
          !params.includeZeroActivity &&
          period.debit === 0 &&
          period.credit === 0 &&
          openingBalance === 0
        ) {
          continue;
        }

        const accountType = account.account_type;
        // Calculate closing balance
        const closingBalance = calculateBalance(
          accountType,
          openingBalance,
          period.debit,
          period.credit
        );

        // Display amount depends on report type
        let displayAmount: number;
        if (params.reportType === "pnl") {
          // For P&L: income shows as positive (credits > debits), expenses positive (debits > credits)
          if (accountType === "income") {
            displayAmount = period.credit - period.debit;
          } else {
            displayAmount = period.debit - period.credit;
          }
        } else {
          displayAmount = closingBalance;
        }

        // Comparison period
        let comparisonAmount: number | undefined;
        let variance: number | undefined;
        let variancePercent: number | null | undefined;

        if (comparisonMovements) {
          const compPeriod = comparisonMovements.get(account.id) || { debit: 0, credit: 0 };
          const compOpening = comparisonOpenings?.get(account.id) ?? 0;

          if (params.reportType === "pnl") {
            comparisonAmount = accountType === "income"
              ? compPeriod.credit - compPeriod.debit
              : compPeriod.debit - compPeriod.credit;
          } else {
            comparisonAmount = calculateBalance(accountType, compOpening, compPeriod.debit, compPeriod.credit);
          }

          variance = displayAmount - comparisonAmount;
          variancePercent = comparisonAmount !== 0
            ? (variance / Math.abs(comparisonAmount)) * 100
            : null;
        }

        totalDebits += period.debit;
        totalCredits += period.credit;

        reportAccounts.push({
          id: account.id,
          code: account.code,
          name: account.name,
          account_type: accountType,
          detail_type: account.detail_type || null,
          parent_id: account.parent_id,
          opening_balance: openingBalance,
          debit_total: period.debit,
          credit_total: period.credit,
          closing_balance: closingBalance,
          display_amount: displayAmount,
          comparison_amount: comparisonAmount,
          variance,
          variance_percent: variancePercent,
          depth: 0,
          is_group: false,
          children: [],
        });
      }

      // Build hierarchy. `buildAccountHierarchy` rolls each subtree UP into its
      // parent (parent's own postings + children), so a group node carries the
      // subtree figure while the row keeps its own figure.
      const hierarchy = buildAccountHierarchy(reportAccounts);

      // Flatten hierarchy back to accounts with depth info
      const flatAccounts: FinancialReportAccount[] = [];
      function flattenNode(node: AccountNode, depth: number) {
        const reportAcct = reportAccounts.find((a) => a.id === node.id);
        if (reportAcct) {
          reportAcct.depth = depth;
          reportAcct.is_group = node.is_group;
          if (node.is_group) {
            // Subtree figure, for the group row's "including sub-accounts" total.
            reportAcct.rollup_amount =
              params.reportType === "pnl"
                ? (reportAcct.account_type === "income"
                    ? node.credit_total - node.debit_total
                    : node.debit_total - node.credit_total)
                : node.closing_balance;
          }
          flatAccounts.push(reportAcct);
        }
        for (const child of node.children.sort((a, b) => a.code.localeCompare(b.code))) {
          flattenNode(child, depth + 1);
        }
      }
      for (const root of hierarchy) {
        flattenNode(root, 0);
      }

      // Group by account type
      const sections: Record<string, FinancialReportAccount[]> = {};
      const sectionTotals: Record<string, number> = {};

      for (const acct of flatAccounts) {
        const type = acct.account_type;
        if (!sections[type]) sections[type] = [];
        sections[type].push(acct);
        if (!sectionTotals[type]) sectionTotals[type] = 0;
        // Every account contributes its OWN amount exactly once. Summing only
        // leaves would drop the own postings of a parent that also has
        // children; summing rolled-up group rows would count them twice.
        sectionTotals[type] += acct.display_amount;
      }


      // Calculate report-specific totals
      let netAmount = 0;
      let netIncome: number | undefined;
      let balanceSheetTotals: FinancialReportData["balanceSheetTotals"] | undefined;
      let isBalanced: boolean | undefined;

      switch (params.reportType) {
        case "pnl": {
          const totalIncome = sectionTotals["income"] || 0;
          const totalExpenses = sectionTotals["expense"] || 0;
          netIncome = totalIncome - totalExpenses;
          netAmount = netIncome;
          break;
        }
        case "balance_sheet": {
          const totalAssets = sectionTotals["asset"] || 0;
          const totalLiabilities = sectionTotals["liability"] || 0;
          const totalEquity = sectionTotals["equity"] || 0;

          // Retained earnings authority is SQL, not the browser.
          // `get_equity_result` returns the fiscal-year start, this year's
          // result and the accumulated result of every closed year. Only the
          // CURRENT year's result is added here: closed years are already
          // folded into the retained-earnings account's opening balance by
          // `get_ledger_opening_balances`, so adding an all-time figure (as
          // this hook used to) counted prior-year profit twice.
          const { data: equityRows, error: equityError } = await supabase.rpc(
            "get_equity_result",
            {
              _org_id: orgId,
              _business_id: businessId ?? null,
              _as_of: params.dateTo,
              _branch_id: params.branchId ?? null,
            },
          );
          if (equityError) throw equityError;
          const equity = Array.isArray(equityRows) ? equityRows[0] : equityRows;

          const currentYearEarnings = Number(equity?.current_year_earnings ?? 0);
          const priorYearsResult = Number(equity?.prior_years_result ?? 0);

          balanceSheetTotals = {
            totalAssets,
            totalLiabilities,
            totalEquity: totalEquity + currentYearEarnings,
            retainedEarnings: currentYearEarnings,
            currentYearEarnings,
            priorYearsResult,
            fiscalYearStart: equity?.fiscal_year_start ?? null,
            hasRetainedEarningsAccount: Boolean(equity?.retained_earnings_account_id),
          };
          netAmount = totalAssets - totalLiabilities - totalEquity - currentYearEarnings;
          break;
        }

        case "trial_balance": {
          // Calculate debit/credit columns for trial balance
          let tbDebit = 0;
          let tbCredit = 0;
          for (const acct of flatAccounts) {
            if (acct.is_group) continue;
            if (isDebitNormal(acct.account_type)) {
              if (acct.closing_balance >= 0) tbDebit += acct.closing_balance;
              else tbCredit += Math.abs(acct.closing_balance);
            } else {
              if (acct.closing_balance >= 0) tbCredit += acct.closing_balance;
              else tbDebit += Math.abs(acct.closing_balance);
            }
          }
          isBalanced = Math.abs(tbDebit - tbCredit) < 0.01;
          netAmount = tbDebit - tbCredit;
          totalDebits = tbDebit;
          totalCredits = tbCredit;
          break;
        }
      }

      // Validate balance sheet integrity
      let validationWarnings: string[] = [];
      if (params.reportType === "balance_sheet") {
        const validation = validateBalanceSheet(flatAccounts, sectionTotals, balanceSheetTotals);
        validationWarnings = validation.warnings;
      }

      return {
        reportType: params.reportType,
        dateRange: { from: params.dateFrom, to: params.dateTo },
        accounts: flatAccounts,
        sections,
        sectionTotals,
        totals: {
          totalDebits,
          totalCredits,
          netAmount,
        },
        isBalanced,
        netIncome,
        balanceSheetTotals,
        validationWarnings: validationWarnings.length > 0 ? validationWarnings : undefined,
      };
    },
    enabled: !!currentOrg?.id,
    staleTime: 30 * 1000, // 30 seconds — accounting needs near-real-time
  });
}

function emptyReport(params: FinancialReportParams): FinancialReportData {
  return {
    reportType: params.reportType,
    dateRange: { from: params.dateFrom, to: params.dateTo },
    accounts: [],
    sections: {},
    sectionTotals: {},
    totals: { totalDebits: 0, totalCredits: 0, netAmount: 0 },
  };
}
