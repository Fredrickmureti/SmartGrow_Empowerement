/**
 * useFiscalPeriodDetail — aggregates all data for a single fiscal period detail page.
 * 
 * Fetches: period metadata, GL movements (income/expense/asset/liability),
 * transaction counts, recent journal entries, close-readiness indicators,
 * AR/AP subledger summaries, budget vs actual, fixed assets, inventory,
 * prior period comparison, and period health score.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import type { FiscalPeriod } from "./useFiscalPeriods";
import { subMonths, subQuarters, subYears, format } from "date-fns";

export interface AccountMovement {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
  total_debit: number;
  total_credit: number;
  net: number;
}

export interface TransactionCounts {
  postedJournalEntries: number;
  draftJournalEntries: number;
  invoices: number;
  draftInvoices: number;
  bills: number;
  draftBills: number;
  payments: number;
  expenses: number;
}

export interface RecentJournalEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string | null;
  reference: string | null;
  status: string;
  source_type: string | null;
}

export interface CloseReadinessItem {
  key: string;
  label: string;
  count: number;
  severity: "blocker" | "warning" | "info";
  resolveLink?: string;
}

export interface CloseReadiness {
  items: CloseReadinessItem[];
  blockers: number;
  warnings: number;
  allClear: boolean;
  healthScore: number;
}

export interface SubledgerSummary {
  arTotal: number;
  apTotal: number;
  arOverdue: number;
  apOverdue: number;
  arCount: number;
  apCount: number;
}

export interface BudgetComparison {
  accountId: string;
  accountName: string;
  accountCode: string;
  budgeted: number;
  actual: number;
  variance: number;
  variancePercent: number;
}

export interface AssetSummary {
  additions: number;
  disposals: number;
  depreciationPosted: number;
  depreciationUnposted: number;
}

export interface PriorPeriodComparison {
  priorRevenue: number;
  priorExpenses: number;
  priorNetIncome: number;
  revenueChange: number;
  expenseChange: number;
  netIncomeChange: number;
}

export interface FiscalPeriodDetailData {
  period: FiscalPeriod | null;
  financials: {
    revenue: number;
    expenses: number;
    netIncome: number;
    totalDebits: number;
    totalCredits: number;
    grossProfit: number;
  };
  accountBreakdown: AccountMovement[];
  topAccounts: AccountMovement[];
  transactionCounts: TransactionCounts;
  recentEntries: RecentJournalEntry[];
  closeReadiness: CloseReadiness;
  subledger: SubledgerSummary;
  budgetComparison: BudgetComparison[];
  assetSummary: AssetSummary;
  priorPeriod: PriorPeriodComparison;
  bankSummary: {
    totalTransactions: number;
    reconciled: number;
    unreconciled: number;
    reconciledPercent: number;
  };
}

function computePriorDates(startDate: string, endDate: string, periodType: string) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  let priorStart: Date, priorEnd: Date;
  
  if (periodType === "quarterly") {
    priorStart = subQuarters(start, 1);
    priorEnd = subQuarters(end, 1);
  } else if (periodType === "yearly") {
    priorStart = subYears(start, 1);
    priorEnd = subYears(end, 1);
  } else {
    priorStart = subMonths(start, 1);
    priorEnd = subMonths(end, 1);
  }
  
  return {
    priorStartDate: format(priorStart, "yyyy-MM-dd"),
    priorEndDate: format(priorEnd, "yyyy-MM-dd"),
  };
}

export function useFiscalPeriodDetail(periodId: string | undefined) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  // 1. Fetch the period record
  const periodQuery = useQuery({
    queryKey: ["fiscal-period", periodId],
    queryFn: async () => {
      if (!periodId) return null;
      const { data, error } = await supabase
        .from("fiscal_periods")
        .select("*")
        .eq("id", periodId)
        .single();
      if (error) throw error;
      return data as FiscalPeriod;
    },
    enabled: !!periodId,
  });

  const period = periodQuery.data;
  const startDate = period?.start_date || "";
  const endDate = period?.end_date || "";
  const periodType = period?.period_type || "monthly";
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  // 2. Fetch all detail data in parallel
  const detailQuery = useQuery({
    queryKey: ["fiscal-period-detail", orgId, businessId, periodId, startDate, endDate],
    queryFn: async (): Promise<Omit<FiscalPeriodDetailData, "period">> => {
      if (!orgId || !businessId || !startDate || !endDate) return emptyDetail();

      const { priorStartDate, priorEndDate } = computePriorDates(startDate, endDate, periodType);
      const today = format(new Date(), "yyyy-MM-dd");

      const [
        movementsResult,
        accountsResult,
        postedJEResult,
        draftJEResult,
        invoicesResult,
        draftInvoicesResult,
        billsResult,
        draftBillsResult,
        paymentsResult,
        expensesResult,
        recentJEResult,
        unreconciledResult,
        reconciledResult,
        totalBankTxnResult,
        // AR/AP
        arResult,
        arOverdueResult,
        apResult,
        apOverdueResult,
        // Prior period GL
        priorMovementsResult,
        // Budget (authoritative server-side comparison)
        budgetVarianceResult,

        // Fixed assets
        assetAdditionsResult,
        assetDisposalsResult,
        depPostedResult,
        depUnpostedResult,
      ] = await Promise.all([
        // GL movements via RPC
        supabase.rpc("get_account_movements", {
          _org_id: orgId,
          _date_from: startDate,
          _date_to: endDate,
          _business_id: businessId || null,
        }),
        // Accounts for type lookup
        supabase
          .from("accounts")
          .select("id, code, name, account_type")
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .eq("is_active", true),
        // Posted JEs count
        supabase
          .from("journal_entries")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .eq("status", "posted")
          .gte("entry_date", startDate)
          .lte("entry_date", endDate),
        // Draft JEs count
        supabase
          .from("journal_entries")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .eq("status", "draft")
          .gte("entry_date", startDate)
          .lte("entry_date", endDate),
        // Invoices count
        supabase
          .from("invoices")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .neq("status", "draft")
          .gte("issue_date", startDate)
          .lte("issue_date", endDate),
        // Draft invoices count
        supabase
          .from("invoices")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .eq("status", "draft")
          .gte("issue_date", startDate)
          .lte("issue_date", endDate),
        // Bills count
        supabase
          .from("bills")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .neq("status", "draft")
          .gte("bill_date", startDate)
          .lte("bill_date", endDate),
        // Draft bills count
        supabase
          .from("bills")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .eq("status", "draft")
          .gte("bill_date", startDate)
          .lte("bill_date", endDate),
        // Payments count
        supabase
          .from("payments")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", businessId)
          .gte("payment_date", startDate)
          .lte("payment_date", endDate),
        // Expenses count
        supabase
          .from("expenses")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .gte("expense_date", startDate)
          .lte("expense_date", endDate),
        // Recent journal entries (last 20)
        supabase
          .from("journal_entries")
          .select("id, entry_number, entry_date, description, reference, status, source_type")
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .gte("entry_date", startDate)
          .lte("entry_date", endDate)
          .order("entry_date", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(20),
        // Unreconciled bank transactions
        supabase
          .from("bank_transactions")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("is_reconciled", false)
          .gte("transaction_date", startDate)
          .lte("transaction_date", endDate),
        // Reconciled bank transactions
        supabase
          .from("bank_transactions")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("is_reconciled", true)
          .gte("transaction_date", startDate)
          .lte("transaction_date", endDate),
        // Total bank transactions
        supabase
          .from("bank_transactions")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .gte("transaction_date", startDate)
          .lte("transaction_date", endDate),
        // AR: open invoices in period
        supabase
          .from("invoices")
          .select("id, total, status", { count: "exact" })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .in("status", ["sent", "confirmed", "overdue", "partial"])
          .gte("issue_date", startDate)
          .lte("issue_date", endDate),
        // AR overdue
        supabase
          .from("invoices")
          .select("id, total", { count: "exact" })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .eq("status", "overdue")
          .gte("issue_date", startDate)
          .lte("issue_date", endDate),
        // AP: open bills in period
        supabase
          .from("bills")
          .select("id, total, status", { count: "exact" })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .in("status", ["received", "overdue", "partial"])
          .gte("bill_date", startDate)
          .lte("bill_date", endDate),
        // AP overdue
        supabase
          .from("bills")
          .select("id, total", { count: "exact" })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .eq("status", "overdue")
          .gte("bill_date", startDate)
          .lte("bill_date", endDate),
        // Prior period GL movements
        supabase.rpc("get_account_movements", {
          _org_id: orgId,
          _date_from: priorStartDate,
          _date_to: priorEndDate,
          _business_id: businessId || null,
        }),
        // Budget vs actual for this period. The database owns the definition
        // of a budget "actual" (period authority, ledger visibility, normal
        // balance direction, favourable-positive variance) — never recompute
        // it here from GL movements.
        supabase.rpc("get_period_budget_variance", { _fiscal_period_id: periodId }),


        // Fixed asset additions
        supabase
          .from("fixed_assets")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .gte("purchase_date", startDate)
          .lte("purchase_date", endDate),
        // Fixed asset disposals
        supabase
          .from("fixed_assets")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .not("disposal_date", "is", null)
          .gte("disposal_date", startDate)
          .lte("disposal_date", endDate),
        // Depreciation posted
        supabase
          .from("depreciation_schedules")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .not("journal_entry_id", "is", null)
          .gte("period_end", startDate)
          .lte("period_end", endDate),
        // Depreciation unposted
        supabase
          .from("depreciation_schedules")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .is("journal_entry_id", null)
          .gte("period_end", startDate)
          .lte("period_end", endDate),
      ]);

      // Build account type map
      const accountMap = new Map<string, { code: string; name: string; type: string }>();
      for (const acct of accountsResult.data || []) {
        accountMap.set(acct.id, { code: acct.code, name: acct.name, type: acct.account_type });
      }

      // Process current period movements
      let revenue = 0;
      let expenses = 0;
      let cogs = 0;
      let totalDebits = 0;
      let totalCredits = 0;
      const accountBreakdown: AccountMovement[] = [];

      for (const mov of movementsResult.data || []) {
        const acct = accountMap.get(mov.account_id);
        if (!acct) continue;

        const debit = Number(mov.total_debit) || 0;
        const credit = Number(mov.total_credit) || 0;
        totalDebits += debit;
        totalCredits += credit;

        let net = 0;
        if (acct.type === "income") {
          net = credit - debit;
          revenue += net;
        } else if (acct.type === "expense") {
          net = debit - credit;
          expenses += net;
          // Detect COGS accounts by name heuristic
          const nameLower = acct.name.toLowerCase();
          if (nameLower.includes("cost of") || nameLower.includes("cogs") || nameLower.includes("cost of sales")) {
            cogs += net;
          }
        } else if (acct.type === "asset") {
          net = debit - credit;
        } else {
          net = credit - debit;
        }

        if (debit > 0 || credit > 0) {
          accountBreakdown.push({
            account_id: mov.account_id,
            account_code: acct.code,
            account_name: acct.name,
            account_type: acct.type as AccountMovement["account_type"],
            total_debit: debit,
            total_credit: credit,
            net,
          });
        }
      }

      accountBreakdown.sort((a, b) => a.account_code.localeCompare(b.account_code));
      const topAccounts = [...accountBreakdown]
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
        .slice(0, 10);

      // Process prior period for comparison
      let priorRevenue = 0;
      let priorExpenses = 0;
      for (const mov of priorMovementsResult.data || []) {
        const acct = accountMap.get(mov.account_id);
        if (!acct) continue;
        const debit = Number(mov.total_debit) || 0;
        const credit = Number(mov.total_credit) || 0;
        if (acct.type === "income") priorRevenue += credit - debit;
        else if (acct.type === "expense") priorExpenses += debit - credit;
      }
      const priorNetIncome = priorRevenue - priorExpenses;
      const currentNetIncome = revenue - expenses;

      // AR/AP summaries
      const arData = arResult.data || [];
      const arTotal = arData.reduce((s: number, inv: any) => s + (Number(inv.total) || 0), 0);
      const arOverdueData = arOverdueResult.data || [];
      const arOverdue = arOverdueData.reduce((s: number, inv: any) => s + (Number(inv.total) || 0), 0);
      
      const apData = apResult.data || [];
      const apTotal = apData.reduce((s: number, b: any) => s + (Number(b.total) || 0), 0);
      const apOverdueData = apOverdueResult.data || [];
      const apOverdue = apOverdueData.reduce((s: number, b: any) => s + (Number(b.total) || 0), 0);

      // Budget comparison — consumed verbatim from the authoritative report.
      // Variance is favourable-positive and already sign-corrected in SQL.
      const budgetComparison: BudgetComparison[] = ((budgetVarianceResult.data as any[]) || []).map((r) => ({
        accountId: r.account_id,
        accountName: r.account_name ?? "Unknown account",
        accountCode: r.account_code ?? "",
        budgeted: Number(r.budgeted_amount) || 0,
        actual: Number(r.actual_amount) || 0,
        variance: Number(r.variance_amount) || 0,
        variancePercent: r.variance_percent === null || r.variance_percent === undefined
          ? null
          : Number(r.variance_percent),
        favourable: r.is_favourable ?? (Number(r.variance_amount) || 0) >= 0,
        unbudgeted: r.is_unbudgeted ?? false,
      }));
      budgetComparison.sort((a, b) => a.accountCode.localeCompare(b.accountCode));


      // Close readiness
      const unpostedJE = draftJEResult.count || 0;
      const draftInv = draftInvoicesResult.count || 0;
      const draftBill = draftBillsResult.count || 0;
      const unreconciledBank = unreconciledResult.count || 0;
      const depUnposted = depUnpostedResult.count || 0;
      const debitCreditDiff = Math.abs(totalDebits - totalCredits);
      const isBalanced = debitCreditDiff < 0.01;

      const closeItems: CloseReadinessItem[] = [
        { key: "unposted_je", label: "Unposted Journal Entries", count: unpostedJE, severity: "blocker", resolveLink: `/finance/journal-entries?status=draft` },
        { key: "debit_credit", label: "Debit/Credit Imbalance", count: isBalanced ? 0 : 1, severity: "blocker" },
        { key: "draft_invoices", label: "Draft Invoices", count: draftInv, severity: "warning", resolveLink: `/finance/invoices?status=draft` },
        { key: "draft_bills", label: "Draft Bills", count: draftBill, severity: "warning", resolveLink: `/finance/bills?status=draft` },
        { key: "unreconciled_bank", label: "Unreconciled Bank Transactions", count: unreconciledBank, severity: "warning", resolveLink: `/finance/reconciliation` },
        { key: "unposted_dep", label: "Unposted Depreciation", count: depUnposted, severity: "warning", resolveLink: `/finance/fixed-assets` },
      ];

      const blockers = closeItems.filter((i) => i.severity === "blocker" && i.count > 0).length;
      const warnings = closeItems.filter((i) => i.severity === "warning" && i.count > 0).length;
      let healthScore = 100;
      healthScore -= blockers * 25;
      healthScore -= warnings * 10;
      healthScore = Math.max(0, Math.min(100, healthScore));

      const reconciledCount = reconciledResult.count || 0;
      const totalBankTxn = totalBankTxnResult.count || 0;

      return {
        financials: {
          revenue,
          expenses,
          netIncome: currentNetIncome,
          totalDebits,
          totalCredits,
          grossProfit: revenue - cogs,
        },
        accountBreakdown,
        topAccounts,
        transactionCounts: {
          postedJournalEntries: postedJEResult.count || 0,
          draftJournalEntries: unpostedJE,
          invoices: invoicesResult.count || 0,
          draftInvoices: draftInv,
          bills: billsResult.count || 0,
          draftBills: draftBill,
          payments: paymentsResult.count || 0,
          expenses: expensesResult.count || 0,
        },
        recentEntries: (recentJEResult.data || []) as RecentJournalEntry[],
        closeReadiness: {
          items: closeItems,
          blockers,
          warnings,
          allClear: blockers === 0 && warnings === 0,
          healthScore,
        },
        subledger: {
          arTotal,
          apTotal,
          arOverdue,
          apOverdue,
          arCount: arResult.count || 0,
          apCount: apResult.count || 0,
        },
        budgetComparison,
        assetSummary: {
          additions: assetAdditionsResult.count || 0,
          disposals: assetDisposalsResult.count || 0,
          depreciationPosted: depPostedResult.count || 0,
          depreciationUnposted: depUnposted,
        },
        priorPeriod: {
          priorRevenue,
          priorExpenses,
          priorNetIncome,
          revenueChange: priorRevenue !== 0 ? ((revenue - priorRevenue) / priorRevenue) * 100 : 0,
          expenseChange: priorExpenses !== 0 ? ((expenses - priorExpenses) / priorExpenses) * 100 : 0,
          netIncomeChange: priorNetIncome !== 0 ? ((currentNetIncome - priorNetIncome) / Math.abs(priorNetIncome)) * 100 : 0,
        },
        bankSummary: {
          totalTransactions: totalBankTxn,
          reconciled: reconciledCount,
          unreconciled: unreconciledBank,
          reconciledPercent: totalBankTxn > 0 ? (reconciledCount / totalBankTxn) * 100 : 100,
        },
      };
    },
    enabled: !!orgId && !!startDate && !!endDate,
    staleTime: 30_000,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["fiscal-period-detail", orgId, businessId, periodId, startDate, endDate] });
    queryClient.invalidateQueries({ queryKey: ["fiscal-period", periodId] });
  };

  // Adjacent periods for navigation
  const adjacentQuery = useQuery({
    queryKey: ["fiscal-period-adjacent", orgId, businessId, periodId, periodType],
    queryFn: async () => {
      if (!orgId || !periodId || !period) return { prev: null, next: null };
      
      const [prevResult, nextResult] = await Promise.all([
        supabase
          .from("fiscal_periods")
          .select("id, name")
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .eq("period_type", periodType)
          .lt("start_date", startDate)
          .order("start_date", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("fiscal_periods")
          .select("id, name")
          .eq("organization_id", orgId)
        .eq("business_id", businessId)
          .eq("business_id", currentBusiness.id)
          .eq("period_type", periodType)
          .gt("start_date", startDate)
          .order("start_date", { ascending: true })
          .limit(1)
          .maybeSingle(),
      ]);

      return {
        prev: prevResult.data as { id: string; name: string } | null,
        next: nextResult.data as { id: string; name: string } | null,
      };
    },
    enabled: !!orgId && !!periodId && !!period,
  });

  return {
    period,
    detail: detailQuery.data || emptyDetail(),
    isLoading: periodQuery.isLoading || detailQuery.isLoading,
    isError: periodQuery.isError || detailQuery.isError,
    refresh,
    adjacentPeriods: adjacentQuery.data || { prev: null, next: null },
  };
}

function emptyDetail(): Omit<FiscalPeriodDetailData, "period"> {
  return {
    financials: { revenue: 0, expenses: 0, netIncome: 0, totalDebits: 0, totalCredits: 0, grossProfit: 0 },
    accountBreakdown: [],
    topAccounts: [],
    transactionCounts: {
      postedJournalEntries: 0, draftJournalEntries: 0,
      invoices: 0, draftInvoices: 0,
      bills: 0, draftBills: 0,
      payments: 0, expenses: 0,
    },
    recentEntries: [],
    closeReadiness: { items: [], blockers: 0, warnings: 0, allClear: true, healthScore: 100 },
    subledger: { arTotal: 0, apTotal: 0, arOverdue: 0, apOverdue: 0, arCount: 0, apCount: 0 },
    budgetComparison: [],
    assetSummary: { additions: 0, disposals: 0, depreciationPosted: 0, depreciationUnposted: 0 },
    priorPeriod: { priorRevenue: 0, priorExpenses: 0, priorNetIncome: 0, revenueChange: 0, expenseChange: 0, netIncomeChange: 0 },
    bankSummary: { totalTransactions: 0, reconciled: 0, unreconciled: 0, reconciledPercent: 100 },
  };
}
