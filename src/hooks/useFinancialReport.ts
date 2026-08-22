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
    retainedEarnings: number;
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

async function fetchPriorMovementsRPC(
  orgId: string,
  beforeDate: string,
  businessId?: string,
  branchId?: string | null
): Promise<Map<string, { debit: number; credit: number }>> {
  const { data, error } = await supabase.rpc("get_account_movements", {
    _org_id: orgId,
    _date_from: "1900-01-01",
    _date_to: new Date(new Date(beforeDate).getTime() - 86400000).toISOString().split("T")[0],
    _business_id: businessId || null,
    _branch_id: branchId || null,
  });
  if (error) throw error;
  return rpcToMap(data || []);
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
      const [accounts, periodByAccount, priorByAccount] = await Promise.all([
        fetchAccounts(orgId, businessId, accountTypes, params.accountIds),
        fetchMovementsRPC(orgId, params.dateFrom, params.dateTo, businessId, params.branchId),
        fetchPriorMovementsRPC(orgId, params.dateFrom, businessId, params.branchId),
      ]);

      // Fetch comparison period if requested
      let comparisonMovements: Map<string, { debit: number; credit: number }> | null = null;
      let comparisonPriorMovements: Map<string, { debit: number; credit: number }> | null = null;
      if (params.comparisonDateFrom && params.comparisonDateTo) {
        const [compMov, compPrior] = await Promise.all([
          fetchMovementsRPC(orgId, params.comparisonDateFrom, params.comparisonDateTo, businessId, params.branchId),
          fetchPriorMovementsRPC(orgId, params.comparisonDateFrom, businessId, params.branchId),
        ]);
        comparisonMovements = compMov;
        comparisonPriorMovements = compPrior;
      }

      // Build report accounts
      const reportAccounts: FinancialReportAccount[] = [];
      let totalDebits = 0;
      let totalCredits = 0;

      for (const account of accounts) {
        const period = periodByAccount.get(account.id) || { debit: 0, credit: 0 };
        const prior = priorByAccount.get(account.id) || { debit: 0, credit: 0 };

        // Skip zero-activity accounts unless requested
        if (
          !params.includeZeroActivity &&
          period.debit === 0 &&
          period.credit === 0 &&
          (account.opening_balance || 0) === 0 &&
          prior.debit === 0 &&
          prior.credit === 0
        ) {
          continue;
        }

        const accountType = account.account_type;
        // Opening = the account's stored opening balance + prior-period JE
        // activity. `accounts.opening_balance` is a business-level property,
        // so a branch-scoped run must NOT carry it (the branch did not open
        // with the whole company's balance). Mirrors `get_general_ledger`.
        const openingRaw = params.branchId ? 0 : (account.opening_balance || 0);


        // Calculate opening balance including account's opening_balance + prior period JE activity
        const openingBalance = calculateBalance(
          accountType,
          openingRaw,
          prior.debit,
          prior.credit
        );

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
          const compPrior = comparisonPriorMovements?.get(account.id) || { debit: 0, credit: 0 };

          if (params.reportType === "pnl") {
            comparisonAmount = accountType === "income"
              ? compPeriod.credit - compPeriod.debit
              : compPeriod.debit - compPeriod.credit;
          } else {
            const compOpening = calculateBalance(accountType, openingRaw, compPrior.debit, compPrior.credit);
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

      // Build hierarchy
      const hierarchy = buildAccountHierarchy(reportAccounts);

      // Flatten hierarchy back to accounts with depth info
      const flatAccounts: FinancialReportAccount[] = [];
      function flattenNode(node: AccountNode, depth: number) {
        const reportAcct = reportAccounts.find((a) => a.id === node.id);
        if (reportAcct) {
          reportAcct.depth = depth;
          reportAcct.is_group = node.is_group;
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
        // Only add root-level for section grouping; children are included via hierarchy
        sections[type].push(acct);
        if (!sectionTotals[type]) sectionTotals[type] = 0;
        // Only count leaf nodes to avoid double-counting
        if (!acct.is_group) {
          sectionTotals[type] += acct.display_amount;
        }
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

          // Calculate retained earnings (current year P&L)
          // Fetch income & expense movements up to dateTo for retained earnings
          const [incExpAccounts, incExpByAccount] = await Promise.all([
            fetchAccounts(orgId, businessId, ["income", "expense"]),
            fetchMovementsRPC(orgId, "1900-01-01", params.dateTo, businessId),
          ]);

          let retainedEarnings = 0;
          for (const acct of incExpAccounts) {
            const mov = incExpByAccount.get(acct.id) || { debit: 0, credit: 0 };
            if (acct.account_type === "income") {
              retainedEarnings += mov.credit - mov.debit;
            } else {
              retainedEarnings -= mov.debit - mov.credit;
            }
          }

          balanceSheetTotals = {
            totalAssets,
            totalLiabilities,
            totalEquity: totalEquity + retainedEarnings,
            retainedEarnings,
          };
          netAmount = totalAssets - totalLiabilities - totalEquity - retainedEarnings;
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
