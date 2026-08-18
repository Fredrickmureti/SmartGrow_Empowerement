/**
 * GL-Sourced Intelligence Hook
 * 
 * Provides accountant-grade business intelligence metrics derived from
 * the General Ledger (single source of truth). Replaces the old
 * useBusinessIntelligence hook's financial metrics with GL data.
 * 
 * Sections:
 * 1. Financial Position (GL-sourced)
 * 2. Performance Trends (GL-sourced)
 * 3. Operational Signals (hybrid — clearly labeled)
 * 4. Risk & Readiness
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { fetchGLTotals } from "@/services/gl/fetchGLTotals";
import { startOfMonth, endOfMonth, subMonths, format, differenceInDays } from "date-fns";

export interface FinancialPosition {
  cashAndEquivalents: number;
  totalReceivables: number;
  totalPayables: number;
  netWorkingCapital: number;
  currentRatio: number;
  quickRatio: number;
}

export interface PerformanceTrend {
  month: string;
  revenue: number;
  expenses: number;
  netIncome: number;
  margin: number;
}

export interface OperationalSignal {
  id: string;
  label: string;
  value: string;
  severity: "info" | "warning" | "critical";
  description: string;
  actionPath?: string;
  source: "gl" | "operational";
}

export interface PeriodCloseItem {
  id: string;
  label: string;
  status: "ok" | "warning" | "action_needed";
  detail: string;
}

export interface IntelligenceData {
  position: FinancialPosition;
  trends: PerformanceTrend[];
  signals: OperationalSignal[];
  closeReadiness: PeriodCloseItem[];
  summary: {
    revenueThisMonth: number;
    revenueLastMonth: number;
    revenueChange: number;
    expensesThisMonth: number;
    netIncomeThisMonth: number;
    totalBankBalance: number;
  };
}

export function useGLIntelligence() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["gl-intelligence", currentOrg?.id, currentBusiness?.id],
    queryFn: async (): Promise<IntelligenceData> => {
      if (!currentOrg?.id) throw new Error("No organization");

      const today = new Date();
      const businessId = currentBusiness?.id || null;

      // ── GL Monthly Trends (6 months) ──
      const monthlyPromises = Array.from({ length: 6 }, (_, i) => {
        const mStart = startOfMonth(subMonths(today, 5 - i));
        const mEnd = endOfMonth(subMonths(today, 5 - i));
        return fetchGLTotals(
          currentOrg.id,
          format(mStart, "yyyy-MM-dd"),
          format(mEnd, "yyyy-MM-dd"),
          businessId
        );
      });

      // ── Operational data (AR/AP/Bank/JE status) ──
      const invoicesP = supabase
        .from("invoices")
        .select("id, total, amount_paid, status, due_date")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("business_id", currentBusiness.id)
        .in("status", ["sent", "viewed", "partial", "overdue"]);

      let billsQ = supabase
        .from("bills")
        .select("id, total, amount_paid, status, due_date")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .in("status", ["received", "partial", "overdue"]);
      billsQ = billsQ.eq("business_id", businessId);
      const billsP = billsQ;

      let bankQ = supabase
        .from("bank_accounts")
        .select("id, is_active, name, account_id")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true);
      bankQ = bankQ.eq("business_id", businessId);
      const bankP = bankQ;

      // Fetch GL-derived balances for bank accounts (single source of truth)
      const glBalancesP = supabase.rpc("get_account_balances", {
        _org_id: currentOrg.id,
        _business_id: null,
      });

      const draftJEP = supabase
        .from("journal_entries")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("business_id", currentBusiness.id)
        .eq("status", "draft");

      const unreconciledP = supabase
        .from("bank_transactions")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_reconciled", false);

      const [
        ...allResults
      ] = await Promise.all([
        ...monthlyPromises,
        invoicesP,
        billsP,
        bankP,
        glBalancesP,
        draftJEP,
        unreconciledP,
      ]);

      // Parse results
      const glMonthly = allResults.slice(0, 6) as Awaited<ReturnType<typeof fetchGLTotals>>[];
      const invoicesRes = allResults[6] as any;
      const billsRes = allResults[7] as any;
      const bankRes = allResults[8] as any;
      const glBalancesRes = allResults[9] as any;
      const draftJERes = allResults[10] as any;
      const unreconciledRes = allResults[11] as any;

      const invoices = invoicesRes.data || [];
      const bills = billsRes.data || [];
      const bankAccounts = bankRes.data || [];
      const glBalances = glBalancesRes.data || [];
      const draftJECount = draftJERes.count || 0;
      const unreconciledCount = unreconciledRes.count || 0;

      // Build GL balance map for bank accounts
      const glBalanceMap = new Map<string, number>();
      for (const row of glBalances) {
        glBalanceMap.set(row.account_id, Number(row.je_balance) || 0);
      }

      // ── Financial Position (GL-derived bank balances) ──
      const totalBankBalance = bankAccounts.reduce((s: number, a: any) => {
        // Use GL-derived balance if the bank account is linked to a GL account
        if (a.account_id && glBalanceMap.has(a.account_id)) {
          return s + glBalanceMap.get(a.account_id)!;
        }
        // Unlinked bank accounts contribute nothing to a GL-derived position.
        return s;
      }, 0);
      const totalReceivables = invoices.reduce((s: number, i: any) => s + (i.total - (i.amount_paid || 0)), 0);
      const totalPayables = bills.reduce((s: number, b: any) => s + (b.total - (b.amount_paid || 0)), 0);
      const currentAssets = totalBankBalance + totalReceivables;
      const netWorkingCapital = currentAssets - totalPayables;
      const currentRatio = totalPayables > 0 ? currentAssets / totalPayables : totalBankBalance > 0 ? 999 : 0;
      const quickRatio = totalPayables > 0 ? totalBankBalance / totalPayables : totalBankBalance > 0 ? 999 : 0;

      // ── Performance Trends ──
      const trends: PerformanceTrend[] = glMonthly.map((gl, i) => {
        const mStart = startOfMonth(subMonths(today, 5 - i));
        const netIncome = gl.revenue - gl.expenses;
        return {
          month: format(mStart, "MMM yyyy"),
          revenue: gl.revenue,
          expenses: gl.expenses,
          netIncome,
          margin: gl.revenue > 0 ? (netIncome / gl.revenue) * 100 : 0,
        };
      });

      const thisMonth = glMonthly[5];
      const lastMonth = glMonthly[4];
      const revenueChange = lastMonth.revenue > 0
        ? ((thisMonth.revenue - lastMonth.revenue) / lastMonth.revenue) * 100
        : thisMonth.revenue > 0 ? 100 : 0;

      // ── Operational Signals ──
      const signals: OperationalSignal[] = [];

      // Overdue receivables
      const overdueAR = invoices
        .filter((i: any) => i.status === "overdue")
        .reduce((s: number, i: any) => s + (i.total - (i.amount_paid || 0)), 0);
      if (overdueAR > 0) {
        signals.push({
          id: "overdue-ar",
          label: "Overdue Receivables",
          value: `${overdueAR.toFixed(0)}`,
          severity: overdueAR > totalReceivables * 0.3 ? "critical" : "warning",
          description: `${invoices.filter((i: any) => i.status === "overdue").length} invoices past due date`,
          actionPath: "/finance/receivables",
          source: "operational",
        });
      }

      // Overdue payables
      const overdueAP = bills
        .filter((b: any) => b.status === "overdue")
        .reduce((s: number, b: any) => s + (b.total - (b.amount_paid || 0)), 0);
      if (overdueAP > 0) {
        signals.push({
          id: "overdue-ap",
          label: "Overdue Payables",
          value: `${overdueAP.toFixed(0)}`,
          severity: "warning",
          description: `${bills.filter((b: any) => b.status === "overdue").length} bills past due date`,
          actionPath: "/finance/payables",
          source: "operational",
        });
      }

      // Bills due within 7 days
      const billsDueSoon = bills.filter((b: any) => {
        if (b.status === "overdue") return false;
        const daysUntil = differenceInDays(new Date(b.due_date), today);
        return daysUntil >= 0 && daysUntil <= 7;
      });
      if (billsDueSoon.length > 0) {
        const amount = billsDueSoon.reduce((s: number, b: any) => s + (b.total - (b.amount_paid || 0)), 0);
        signals.push({
          id: "bills-due-soon",
          label: "Bills Due This Week",
          value: `${amount.toFixed(0)}`,
          severity: "info",
          description: `${billsDueSoon.length} bill(s) due within 7 days`,
          actionPath: "/finance/payables",
          source: "operational",
        });
      }

      // Low liquidity warning
      if (currentRatio < 1 && currentRatio > 0) {
        signals.push({
          id: "low-liquidity",
          label: "Low Liquidity",
          value: `${currentRatio.toFixed(2)}`,
          severity: "critical",
          description: "Current ratio below 1.0 — current liabilities exceed current assets",
          source: "gl",
        });
      }

      // Revenue decline
      if (revenueChange < -10) {
        signals.push({
          id: "revenue-decline",
          label: "Revenue Decline",
          value: `${revenueChange.toFixed(1)}%`,
          severity: revenueChange < -25 ? "critical" : "warning",
          description: `Revenue decreased ${Math.abs(revenueChange).toFixed(1)}% vs last month (GL-sourced)`,
          actionPath: "/finance/reports/financial",
          source: "gl",
        });
      }

      // ── Period Close Readiness ──
      const closeReadiness: PeriodCloseItem[] = [
        {
          id: "draft-entries",
          label: "Draft Journal Entries",
          status: draftJECount === 0 ? "ok" : "action_needed",
          detail: draftJECount === 0 ? "No draft entries" : `${draftJECount} entries pending review/posting`,
        },
        {
          id: "unreconciled",
          label: "Unreconciled Transactions",
          status: unreconciledCount === 0 ? "ok" : unreconciledCount < 10 ? "warning" : "action_needed",
          detail: unreconciledCount === 0 ? "All transactions reconciled" : `${unreconciledCount} unreconciled bank transactions`,
        },
        {
          id: "overdue-invoices",
          label: "Overdue Invoices",
          status: overdueAR === 0 ? "ok" : "warning",
          detail: overdueAR === 0 ? "No overdue invoices" : `${invoices.filter((i: any) => i.status === "overdue").length} overdue invoices`,
        },
      ];

      return {
        position: {
          cashAndEquivalents: totalBankBalance,
          totalReceivables,
          totalPayables,
          netWorkingCapital,
          currentRatio,
          quickRatio,
        },
        trends,
        signals,
        closeReadiness,
        summary: {
          revenueThisMonth: thisMonth.revenue,
          revenueLastMonth: lastMonth.revenue,
          revenueChange,
          expensesThisMonth: thisMonth.expenses,
          netIncomeThisMonth: thisMonth.netProfit,
          totalBankBalance,
        },
      };
    },
    enabled: !!currentOrg?.id,
    staleTime: 5 * 60 * 1000,
  });
}
