/**
 * useDashboardStats — scope-aware dashboard totals + activity.
 *
 * Dashboard headline P&L uses `get_account_movements`, the same posted-GL
 * accounting engine used by financial reports. Scope authorization is still
 * enforced server-side via `get_dashboard_activity` / `assert_can_view_dashboard_scope`.
 *
 * The legacy implementation issued raw Supabase queries with NO
 * branch filter and a cache key without branch_id, so a Branch A
 * user transparently saw the entire business's totals. That
 * leakage is closed here by:
 *   - delegating filtering to the database RPC
 *   - keying the cache on (orgId, businessId, scopeKind, branchId)
 *   - waiting for `useDashboardScope().isReady` before fetching
 *
 * Return shape is preserved so consumers (Dashboard.tsx,
 * QuickStats, ExecutiveOverview) need no changes in this commit.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { startOfMonth, endOfMonth, subMonths, format } from "date-fns";
import { queryKeys } from "@/lib/queryKeys";
import { useDashboardScope } from "./useDashboardScope";

interface DashboardStats {
  totalRevenue: number;
  totalRevenueChange: number;
  outstandingInvoices: number;
  outstandingCount: number;
  totalExpenses: number;
  totalExpensesChange: number;
  netProfit: number;
  recentActivity: Activity[];
  monthlyRevenue: MonthlyData[];
  monthlyExpenses: MonthlyData[];
}

interface Activity {
  id: string;
  type: "invoice" | "payment" | "expense" | "bill";
  description: string;
  amount: number;
  date: string;
}

interface MonthlyData {
  month: string;
  amount: number;
}


interface AccountRow {
  id: string;
  account_type: "asset" | "liability" | "equity" | "income" | "expense";
}

interface MovementRow {
  account_id: string;
  total_debit: number | string | null;
  total_credit: number | string | null;
}

function calculatePnL(movements: MovementRow[], accounts: AccountRow[]) {
  const typeByAccount = new Map(accounts.map((a) => [a.id, a.account_type]));
  let revenue = 0;
  let expenses = 0;

  for (const movement of movements || []) {
    const accountType = typeByAccount.get(movement.account_id);
    const debit = Number(movement.total_debit) || 0;
    const credit = Number(movement.total_credit) || 0;

    if (accountType === "income") {
      revenue += credit - debit;
    } else if (accountType === "expense") {
      expenses += debit - credit;
    }
  }

  return { revenue, expenses, netProfit: revenue - expenses };
}

const emptyStats: DashboardStats = {
  totalRevenue: 0,
  totalRevenueChange: 0,
  outstandingInvoices: 0,
  outstandingCount: 0,
  totalExpenses: 0,
  totalExpensesChange: 0,
  netProfit: 0,
  recentActivity: [],
  monthlyRevenue: [],
  monthlyExpenses: [],
};

export function useDashboardStats() {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const scope = useDashboardScope();

  const orgId = currentOrg?.id;
  const businessId = scope.businessId;
  const scopeKind = scope.kind;
  const branchId = scope.branchId;

  const { data: stats = emptyStats, isLoading } = useQuery({
    queryKey: queryKeys.dashboard.stats(orgId || "", businessId, scopeKind, branchId),
    queryFn: async (): Promise<DashboardStats> => {
      if (!orgId || !businessId) return emptyStats;

      const now = new Date();
      const to = format(now, "yyyy-MM-dd");
      const allTimeFrom = "1900-01-01";

      // First call a server-enforced dashboard RPC so unauthorized scope
      // requests fail before any metric is shown. The prior get_dashboard_stats
      // RPC is intentionally not used here because its monthly JSON query can
      // throw `aggregate function calls cannot be nested`, causing the UI to
      // show all-zero stats. Totals below come from get_account_movements, the
      // same posted-GL engine used by the financial reports.
      const { data: activityRaw, error: activityError } = await supabase.rpc("get_dashboard_activity" as any, {
        _business_id: businessId,
        _branch_id: branchId,
        _kind: scopeKind,
        _limit: 20,
      } as any);

      if (activityError) {
        console.warn("[useDashboardStats] scope enforcement/activity failed:", activityError.message);
        return emptyStats;
      }

      let accountsQuery = supabase
        .from("accounts")
        .select("id, account_type")
        .eq("organization_id", orgId)
        .eq("is_active", true)
        .in("account_type", ["income", "expense"]);

      accountsQuery = accountsQuery.or(`business_id.eq.${businessId},business_id.is.null`);
      const { data: accountsRaw, error: accountsError } = await accountsQuery;
      if (accountsError) {
        console.warn("[useDashboardStats] accounts fetch failed:", accountsError.message);
        return emptyStats;
      }
      const accounts = (accountsRaw || []) as AccountRow[];

      const movementParams = (from: string, toDate: string) => ({
        _org_id: orgId,
        _date_from: from,
        _date_to: toDate,
        _business_id: businessId,
        _branch_id: scopeKind === "branch_only" ? branchId : null,
      });

      const { data: allMovementsRaw, error: allMovementsError } = await supabase.rpc(
        "get_account_movements" as any,
        movementParams(allTimeFrom, to) as any,
      );
      if (allMovementsError) {
        console.warn("[useDashboardStats] get_account_movements failed:", allMovementsError.message);
        return emptyStats;
      }

      const allTime = calculatePnL((allMovementsRaw || []) as MovementRow[], accounts);

      const monthStarts: Date[] = [];
      for (let i = 5; i >= 0; i--) monthStarts.push(startOfMonth(subMonths(now, i)));

      const monthlyRows = await Promise.all(monthStarts.map(async (monthStart) => {
        const from = format(monthStart, "yyyy-MM-dd");
        const monthTo = format(endOfMonth(monthStart), "yyyy-MM-dd");
        const { data, error } = await supabase.rpc(
          "get_account_movements" as any,
          movementParams(from, monthTo) as any,
        );
        if (error) {
          console.warn("[useDashboardStats] monthly movements failed:", error.message);
          return { month: format(monthStart, "MMM"), revenue: 0, expenses: 0 };
        }
        const pnl = calculatePnL((data || []) as MovementRow[], accounts);
        return { month: format(monthStart, "MMM"), revenue: pnl.revenue, expenses: pnl.expenses };
      }));

      const { data: outstandingRows, error: outstandingError } = await (() => {
        let q = supabase
          .from("invoices")
          .select("total, amount_paid", { count: "exact" })
          .eq("organization_id", orgId)
          .eq("business_id", businessId)
          .in("status", ["sent", "viewed", "partial", "overdue", "confirmed"]);
        if (scopeKind === "branch_only" && branchId) q = q.eq("branch_id", branchId);
        return q;
      })();
      if (outstandingError) {
        console.warn("[useDashboardStats] outstanding invoices failed:", outstandingError.message);
      }

      const outstandingAmount = (outstandingRows || []).reduce(
        (sum: number, row: any) => sum + ((Number(row.total) || 0) - (Number(row.amount_paid) || 0)),
        0,
      );
      const outstandingCount = outstandingRows?.length ?? 0;

      const monthlyRevenue: MonthlyData[] = monthlyRows.map((m) => ({ month: m.month, amount: m.revenue }));
      const monthlyExpenses: MonthlyData[] = monthlyRows.map((m) => ({ month: m.month, amount: m.expenses }));

      const lastRevenue = monthlyRevenue[monthlyRevenue.length - 1]?.amount ?? 0;
      const previousRevenue = monthlyRevenue[monthlyRevenue.length - 2]?.amount ?? 0;
      const revenueChange = previousRevenue > 0
        ? ((lastRevenue - previousRevenue) / previousRevenue) * 100
        : lastRevenue > 0 ? 100 : 0;

      const lastExpenses = monthlyExpenses[monthlyExpenses.length - 1]?.amount ?? 0;
      const previousExpenses = monthlyExpenses[monthlyExpenses.length - 2]?.amount ?? 0;
      const expensesChange = previousExpenses > 0
        ? ((lastExpenses - previousExpenses) / previousExpenses) * 100
        : lastExpenses > 0 ? 100 : 0;

      const activityRows = activityRaw
        ? (((activityRaw as any).activity ?? []) as Array<{
            id: string; type: string; description: string; amount: number; date: string;
          }>)
        : [];
      const recentActivity: Activity[] = activityRows.slice(0, 10).map((r) => ({
        id: r.id,
        type: (["invoice", "payment", "expense", "bill"].includes(r.type) ? r.type : "invoice") as Activity["type"],
        description: r.description,
        amount: Number(r.amount) || 0,
        date: r.date,
      }));

      return {
        totalRevenue: allTime.revenue,
        totalRevenueChange: revenueChange,
        outstandingInvoices: outstandingAmount,
        outstandingCount,
        totalExpenses: allTime.expenses,
        totalExpensesChange: expensesChange,
        netProfit: allTime.netProfit,
        recentActivity,
        monthlyRevenue,
        monthlyExpenses,
      };
    },
    enabled: !!orgId && !!businessId && scope.isReady,
    staleTime: 30_000,
  });

  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.dashboard.stats(orgId || "", businessId, scopeKind, branchId),
    });
  };

  return { stats, isLoading, refresh, scope };
}
