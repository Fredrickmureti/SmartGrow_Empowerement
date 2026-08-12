import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { startOfMonth, endOfMonth, subMonths, format } from "date-fns";
import { useDashboardScope } from "./useDashboardScope";
import {
  fetchARSummary,
  fetchAPSummary,
  fetchTopOpenCounterparties,
} from "@/services/finance/openItems";

/** Identity on the select string — keeps it out of the type-level parser. */
const sel = (s: string): string => s;


export interface SalesSummary {
  totalSales: number;
  salesCount: number;
  avgOrderValue: number;
  salesGrowth: number;
  topProducts: { name: string; quantity: number; revenue: number }[];
  salesByPeriod: { period: string; amount: number }[];
}

export interface CashFlowData {
  inflows: number;
  outflows: number;
  netCashFlow: number;
  projectedBalance: number;
  cashFlowByPeriod: { period: string; inflow: number; outflow: number }[];
}

export interface ProfitMarginData {
  grossMargin: number;
  netMargin: number;
  grossProfit: number;
  netProfit: number;
  marginTrend: { period: string; grossMargin: number; netMargin: number }[];
}

export interface ExpenseCategoryData {
  categories: { name: string; amount: number; percentage: number; color: string }[];
  totalExpenses: number;
  expenseGrowth: number;
}

/**
 * Bucket fields use the canonical AR/AP aging vocabulary owned by SQL
 * (see `src/services/finance/aging.ts`):
 *   notDue = not yet due, current = 0-30 past due, days30 = 31-60,
 *   days60 = 61-90, days90 = 90+.
 * `totalOverdue` is every bucket except `notDue` — anything past due.
 */
export interface ReceivablesData {
  totalReceivables: number;
  notDue: number;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  totalOverdue: number;
  topDebtors: { name: string; amount: number; daysOverdue: number }[];
}

export interface PayablesData {
  totalPayables: number;
  notDue: number;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  totalOverdue: number;
}


export interface DashboardAnalytics {
  salesSummary: SalesSummary;
  cashFlow: CashFlowData;
  profitMargin: ProfitMarginData;
  expenseCategories: ExpenseCategoryData;
  receivables: ReceivablesData;
  payables: PayablesData;
  cashBalance: number;
  bankBalances: { accountName: string; balance: number; currency: string }[];
}

const CATEGORY_COLORS = [
  "hsl(221, 83%, 53%)", // primary blue
  "hsl(262, 83%, 58%)", // accent purple
  "hsl(142, 76%, 36%)", // success green
  "hsl(38, 92%, 50%)",  // warning orange
  "hsl(0, 84%, 60%)",   // destructive red
  "hsl(180, 70%, 45%)", // cyan
  "hsl(320, 70%, 50%)", // pink
  "hsl(60, 70%, 45%)",  // yellow
];

export function useDashboardAnalytics() {
  const { currentOrg } = useOrganization();
  const scope = useDashboardScope();
  const [analytics, setAnalytics] = useState<DashboardAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (currentOrg && scope.isReady && scope.businessId) {
      fetchAnalytics();
    }
    // Re-fetch when scope changes (business switch, branch switch,
    // consolidated toggle).
  }, [currentOrg?.id, scope.businessId, scope.kind, scope.branchId, scope.isReady]);

  const fetchAnalytics = async () => {
    if (!currentOrg || !scope.businessId) return;
    setIsLoading(true);
    const orgId = currentOrg.id;
    const businessId = scope.businessId;
    // Strict branch filter: in branch_only mode rows MUST have
    // branch_id == scope.branchId. We do NOT widen with `IS NULL`
    // any more — that was the silent leakage the audit identified.
    // In all_branches and business_only mode no branch filter is
    // applied (those modes intentionally span branches).
    const branchEq = scope.kind === "branch_only" ? scope.branchId : null;

    /**
     * Apply org + business + (optional) strict branch scope.
     * `opts.branchScoped = false` for tables without a `branch_id`
     * column (currently only `expenses`); the UI must label the
     * affected card "Business-level" in branch_only mode.
     */
    const applyScope = <Q,>(q: Q, opts: { branchScoped?: boolean } = {}): Q => {
      const { branchScoped = true } = opts;
      let qq: any = (q as any).eq("organization_id", orgId).eq("business_id", businessId);
      if (branchScoped && branchEq) qq = qq.eq("branch_id", branchEq);
      return qq;
    };

    try {
      const now = new Date();
      const thisMonthStart = startOfMonth(now);
      const thisMonthEnd = endOfMonth(now);
      const lastMonthStart = startOfMonth(subMonths(now, 1));
      const lastMonthEnd = endOfMonth(subMonths(now, 1));
      // Fetch all required data in parallel — scoped to active org + (optional) business.

      const invoicesQuery = applyScope(
        supabase.from("invoices").select("*, contact:contacts(name), invoice_items(*)")
      );

      const paymentsQuery = applyScope(
        supabase.from("payments").select("*, payment_allocations(amount, invoice:invoices(invoice_number)), contact:contacts(name)")
      );

      // Expenses table has no branch_id column → company-scope only.
      // `sel()` keeps the embedded-select string out of the type-level parser
      // (see query-builder-type-performance): the expenses row type is wide
      // enough that parsing it inline blows the instantiation depth limit.
      const expensesQuery = applyScope(
        supabase.from("expenses").select(sel("*, category:expense_categories(name)")),
        { branchScoped: false }
      );

      const billsQuery = applyScope(
        supabase.from("bills").select("*, vendor:contacts(name)")
      );

      // ADR 0126: voided supplier payments are retained as history but are
      // not cash out — exclude them from analytics.
      const billPaymentsQuery = applyScope(
        supabase.from("bill_payments").select("*")
      ).neq("status", "voided");


      const bankAccountsQuery = applyScope(
        supabase.from("bank_accounts").select("*")
      ).eq("is_active", true);

      // POS transactions — completed, no invoice_id (avoids double-counting credit sales)
      const posQuery = applyScope(
        supabase.from("pos_transactions").select("id, total, created_at, status")
      ).eq("status", "completed").is("invoice_id", null);

      // POS transaction items for top products — filtered downstream by transaction_id
      const posItemsQuery = supabase.from("pos_transaction_items").select("description, quantity, line_total, transaction_id");

      const [
        { data: invoices },
        { data: payments },
        { data: expenses },
        { data: bills },
        { data: billPayments },
        { data: bankAccounts },
        { data: expenseCategories },
      ] = await Promise.all([
        invoicesQuery,
        paymentsQuery,
        expensesQuery,
        billsQuery,
        billPaymentsQuery,
        bankAccountsQuery,
        applyScope(
          supabase.from("expense_categories").select("*"),
          { branchScoped: false },
        ),
      ]);

      // Fetch POS data separately to avoid deep type instantiation
      const { data: posTransactions } = await posQuery;
      const { data: posItems } = await posItemsQuery;

      // Filter POS items to only include items from non-invoiced completed transactions
      const posCompletedIds = new Set((posTransactions || []).map(t => t.id));
      const filteredPosItems = (posItems || []).filter(item => posCompletedIds.has(item.transaction_id));
      const posTxns = posTransactions || [];

      // Calculate Sales Summary — includes POS direct sales
      const paidInvoices = invoices?.filter(i => i.status === "paid") || [];

      const thisMonthInvoiceSales = paidInvoices.filter(i => {
        const date = new Date(i.issue_date);
        return date >= thisMonthStart && date <= thisMonthEnd;
      });
      const lastMonthInvoiceSales = paidInvoices.filter(i => {
        const date = new Date(i.issue_date);
        return date >= lastMonthStart && date <= lastMonthEnd;
      });

      const thisMonthPOS = posTxns.filter(t => {
        const date = new Date(t.created_at);
        return date >= thisMonthStart && date <= thisMonthEnd;
      }).reduce((sum, t) => sum + t.total, 0);

      const lastMonthPOS = posTxns.filter(t => {
        const date = new Date(t.created_at);
        return date >= lastMonthStart && date <= lastMonthEnd;
      }).reduce((sum, t) => sum + t.total, 0);

      const totalInvoiceSales = paidInvoices.reduce((sum, i) => sum + i.total, 0);
      const totalPOSSales = posTxns.reduce((sum, t) => sum + t.total, 0);
      const totalSales = totalInvoiceSales + totalPOSSales;

      const thisMonthTotal = thisMonthInvoiceSales.reduce((sum, i) => sum + i.total, 0) + thisMonthPOS;
      const lastMonthTotal = lastMonthInvoiceSales.reduce((sum, i) => sum + i.total, 0) + lastMonthPOS;

      const salesGrowth = lastMonthTotal > 0 
        ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100 
        : thisMonthTotal > 0 ? 100 : 0;

      // Top products from invoice items + POS items
      const productSales: Record<string, { name: string; quantity: number; revenue: number }> = {};
      paidInvoices.forEach(inv => {
        const items = (inv as any).invoice_items || [];
        items.forEach((item: any) => {
          const key = item.description || "Unknown";
          if (!productSales[key]) {
            productSales[key] = { name: key, quantity: 0, revenue: 0 };
          }
          productSales[key].quantity += item.quantity || 1;
          productSales[key].revenue += item.line_total || 0;
        });
      });

      // Merge POS product sales
      filteredPosItems.forEach((item: any) => {
        const key = item.description || "Unknown";
        if (!productSales[key]) {
          productSales[key] = { name: key, quantity: 0, revenue: 0 };
        }
        productSales[key].quantity += item.quantity || 1;
        productSales[key].revenue += item.line_total || 0;
      });

      const topProducts = Object.values(productSales)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);

      // Sales by period (last 6 months) — includes POS
      const salesByPeriod = [];
      for (let i = 5; i >= 0; i--) {
        const periodStart = startOfMonth(subMonths(now, i));
        const periodEnd = endOfMonth(subMonths(now, i));
        const periodInvoiceSales = paidInvoices
          .filter(inv => {
            const date = new Date(inv.issue_date);
            return date >= periodStart && date <= periodEnd;
          })
          .reduce((sum, inv) => sum + inv.total, 0);
        const periodPOSSales = posTxns
          .filter(t => {
            const date = new Date(t.created_at);
            return date >= periodStart && date <= periodEnd;
          })
          .reduce((sum, t) => sum + t.total, 0);
        salesByPeriod.push({
          period: format(periodStart, "MMM"),
          amount: periodInvoiceSales + periodPOSSales,
        });
      }

      const totalSalesCount = paidInvoices.length + posTxns.length;

      const salesSummary: SalesSummary = {
        totalSales,
        salesCount: totalSalesCount,
        avgOrderValue: totalSalesCount > 0 ? totalSales / totalSalesCount : 0,
        salesGrowth,
        topProducts,
        salesByPeriod,
      };

      // Calculate Cash Flow
      const allPayments = payments || [];
      const allBillPayments = billPayments || [];
      const allExpenses = expenses?.filter(e => e.status === "approved" || e.status === "paid") || [];

      // Inflows (customer payments + POS cash/card sales)
      const totalPaymentInflows = allPayments.reduce((sum, p) => sum + p.amount, 0);
      const totalPOSInflows = posTxns.reduce((sum, t) => sum + t.total, 0);
      const totalInflows = totalPaymentInflows + totalPOSInflows;
      
      // Outflows (bill payments + expenses)
      const totalBillPayments = allBillPayments.reduce((sum, p) => sum + p.amount, 0);
      const totalExpensePayments = allExpenses.reduce((sum, e) => sum + e.amount, 0);
      const totalOutflows = totalBillPayments + totalExpensePayments;

      // Cash flow by period
      const cashFlowByPeriod = [];
      for (let i = 5; i >= 0; i--) {
        const periodStart = startOfMonth(subMonths(now, i));
        const periodEnd = endOfMonth(subMonths(now, i));

        const periodInflow = allPayments
          .filter(p => {
            const date = new Date(p.payment_date);
            return date >= periodStart && date <= periodEnd;
          })
          .reduce((sum, p) => sum + p.amount, 0);

        const periodPOSInflow = posTxns
          .filter(t => {
            const date = new Date(t.created_at);
            return date >= periodStart && date <= periodEnd;
          })
          .reduce((sum, t) => sum + t.total, 0);

        const periodBillPayments = allBillPayments
          .filter(p => {
            const date = new Date(p.payment_date);
            return date >= periodStart && date <= periodEnd;
          })
          .reduce((sum, p) => sum + p.amount, 0);

        const periodExpenses = allExpenses
          .filter(e => {
            const date = new Date(e.expense_date);
            return date >= periodStart && date <= periodEnd;
          })
          .reduce((sum, e) => sum + e.amount, 0);

        cashFlowByPeriod.push({
          period: format(periodStart, "MMM"),
          inflow: periodInflow + periodPOSInflow,
          outflow: periodBillPayments + periodExpenses,
        });
      }

      // Bank balances — derive from GL accounts where linked
      const glAccountIds = (bankAccounts || []).filter(a => a.account_id).map(a => a.account_id);
      let glAccountMap: Record<string, { opening_balance: number; current_balance: number }> = {};
      if (glAccountIds.length > 0) {
        const { data: glAccs } = await supabase
          .from("accounts")
          .select("id, opening_balance, current_balance")
          .in("id", glAccountIds);
        if (glAccs) {
          for (const ga of glAccs) {
            glAccountMap[ga.id] = ga;
          }
        }
      }

      const bankBalances = (bankAccounts || []).map(acc => {
        let balance = acc.current_balance || 0;
        if (acc.account_id && glAccountMap[acc.account_id]) {
          const gl = glAccountMap[acc.account_id];
          balance = (gl.opening_balance || 0) + (gl.current_balance || 0);
        }
        return {
          accountName: acc.name,
          balance,
          currency: acc.currency || "USD", // architecture-allow: display-only fallback
        };
      });

      const totalBankBalance = bankBalances.reduce((sum, b) => sum + b.balance, 0);

      const cashFlow: CashFlowData = {
        inflows: totalInflows,
        outflows: totalOutflows,
        netCashFlow: totalInflows - totalOutflows,
        projectedBalance: totalBankBalance + (totalInflows - totalOutflows),
        cashFlowByPeriod,
      };

      // Calculate Profit Margin — includes POS revenue
      const totalRevenue = totalSales; // already includes invoice + POS
      const totalCosts = allExpenses.reduce((sum, e) => sum + e.amount, 0);
      const grossProfit = totalRevenue - totalCosts;
      const grossMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
      
      // For net margin, we'd ideally have COGS separate, but we'll use all expenses
      const netProfit = grossProfit;
      const netMargin = grossMargin;

      // Margin trend
      const marginTrend = [];
      for (let i = 5; i >= 0; i--) {
        const periodStart = startOfMonth(subMonths(now, i));
        const periodEnd = endOfMonth(subMonths(now, i));

        const periodInvRevenue = paidInvoices
          .filter(inv => {
            const date = new Date(inv.issue_date);
            return date >= periodStart && date <= periodEnd;
          })
          .reduce((sum, inv) => sum + inv.total, 0);

        const periodPOSRev = posTxns
          .filter(t => {
            const date = new Date(t.created_at);
            return date >= periodStart && date <= periodEnd;
          })
          .reduce((sum, t) => sum + t.total, 0);

        const periodRevenue = periodInvRevenue + periodPOSRev;

        const periodExpenses = allExpenses
          .filter(e => {
            const date = new Date(e.expense_date);
            return date >= periodStart && date <= periodEnd;
          })
          .reduce((sum, e) => sum + e.amount, 0);

        const periodGrossMargin = periodRevenue > 0 
          ? ((periodRevenue - periodExpenses) / periodRevenue) * 100 
          : 0;

        marginTrend.push({
          period: format(periodStart, "MMM"),
          grossMargin: periodGrossMargin,
          netMargin: periodGrossMargin, // Simplified
        });
      }

      const profitMargin: ProfitMarginData = {
        grossMargin,
        netMargin,
        grossProfit,
        netProfit,
        marginTrend,
      };

      // Calculate Expense Categories
      const expenseByCategory: Record<string, number> = {};
      const totalExpensesAmount = allExpenses.reduce((sum, e) => {
        const categoryName = (e as any).category?.name || "Uncategorized";
        expenseByCategory[categoryName] = (expenseByCategory[categoryName] || 0) + e.amount;
        return sum + e.amount;
      }, 0);

      const categories = Object.entries(expenseByCategory)
        .map(([name, amount], index) => ({
          name,
          amount,
          percentage: totalExpensesAmount > 0 ? (amount / totalExpensesAmount) * 100 : 0,
          color: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8);

      // Expense growth
      const thisMonthExpenses = allExpenses
        .filter(e => {
          const date = new Date(e.expense_date);
          return date >= thisMonthStart && date <= thisMonthEnd;
        })
        .reduce((sum, e) => sum + e.amount, 0);

      const lastMonthExpenses = allExpenses
        .filter(e => {
          const date = new Date(e.expense_date);
          return date >= lastMonthStart && date <= lastMonthEnd;
        })
        .reduce((sum, e) => sum + e.amount, 0);

      const expenseGrowth = lastMonthExpenses > 0
        ? ((thisMonthExpenses - lastMonthExpenses) / lastMonthExpenses) * 100
        : thisMonthExpenses > 0 ? 100 : 0;

      const expenseCategoriesData: ExpenseCategoryData = {
        categories,
        totalExpenses: totalExpensesAmount,
        expenseGrowth,
      };

      // Receivables & Payables — GL-anchored. These come from the same
      // open-item projections that drive the AR/AP workspaces, ageing report
      // and control-account reconciliation. Invoice/bill document status is
      // deliberately NOT used here: a document without a posted journal entry
      // is an integrity exception, not a receivable.
      const [arSummary, apSummary, topDebtors] = await Promise.all([
        fetchARSummary(orgId, businessId, branchEq),
        fetchAPSummary(orgId, businessId, branchEq),
        fetchTopOpenCounterparties("ar", orgId, businessId, branchEq, 5),
      ]);

      const receivables: ReceivablesData = {
        totalReceivables: arSummary.totalResidual,
        notDue: arSummary.notDue,
        current: arSummary.current,
        days30: arSummary.days30,
        days60: arSummary.days60,
        days90: arSummary.days90,
        totalOverdue:
          arSummary.current + arSummary.days30 + arSummary.days60 + arSummary.days90,
        topDebtors,
      };

      const payables: PayablesData = {
        totalPayables: apSummary.totalResidual,
        notDue: apSummary.notDue,
        current: apSummary.current,
        days30: apSummary.days30,
        days60: apSummary.days60,
        days90: apSummary.days90,
        totalOverdue:
          apSummary.current + apSummary.days30 + apSummary.days60 + apSummary.days90,
      };



      setAnalytics({
        salesSummary,
        cashFlow,
        profitMargin,
        expenseCategories: expenseCategoriesData,
        receivables,
        payables,
        cashBalance: totalBankBalance,
        bankBalances,
      });
    } catch (error) {
      console.error("Error fetching dashboard analytics:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return { analytics, isLoading, refresh: fetchAnalytics };
}
