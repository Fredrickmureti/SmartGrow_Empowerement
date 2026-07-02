import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { startOfMonth, subMonths, differenceInDays, format } from "date-fns";
import { fetchGLTotals } from "@/services/gl/fetchGLTotals";
import { queryKeys } from "@/lib/queryKeys";
import { useDashboardScope } from "./useDashboardScope";

export interface BusinessScorecard {
  businessId: string;
  businessName: string;
  revenue: number;
  expenses: number;
  profit: number;
  margin: number;
  customerCount: number;
  outstandingAR: number;
  isOperationalEstimate: true;
}

export interface TopDebtor {
  contactName: string;
  businessName: string;
  amount: number;
  daysOverdue: number;
}

export interface ExpenseCategorySummary {
  category: string;
  amount: number;
  percentage: number;
}

export interface ExecutiveStats {
  totalCustomers: number;
  newCustomersThisMonth: number;
  newCustomersLastMonth: number;
  customerGrowth: number;
  businessScorecards: BusinessScorecard[];
  totalPayables: number;
  totalReceivables: number;
  cashPosition: number;
  dso: number;
  collectionRate: number;
  employeeCount: number;
  revenuePerEmployee: number;
  topDebtors: TopDebtor[];
  expensesByCategory: ExpenseCategorySummary[];
}

const emptyStats: ExecutiveStats = {
  totalCustomers: 0,
  newCustomersThisMonth: 0,
  newCustomersLastMonth: 0,
  customerGrowth: 0,
  businessScorecards: [],
  totalPayables: 0,
  totalReceivables: 0,
  cashPosition: 0,
  dso: 0,
  collectionRate: 0,
  employeeCount: 0,
  revenuePerEmployee: 0,
  topDebtors: [],
  expensesByCategory: [],
};

export function useExecutiveStats() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const scope = useDashboardScope();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const { data: stats = emptyStats, isLoading } = useQuery({
    // Cache key includes scope so switching branches / toggling
    // consolidated invalidates correctly. Headline numbers come from
    // `get_executive_stats` (server-side scope enforcement via
    // `assert_can_view_dashboard_scope`); per-business scorecards,
    // top debtors and expense-by-category are derived client-side
    // from raw queries that are now strictly business + branch scoped.
    queryKey: queryKeys.dashboard.executive(
      orgId || "",
      scope.businessId,
      scope.kind,
      scope.branchId,
    ),
    queryFn: async (): Promise<ExecutiveStats> => {
      if (!orgId || !scope.businessId) return emptyStats;
      // Frontend gate is defense-in-depth only; real enforcement is in
      // the `get_executive_stats` RPC which raises 42501 when the user
      // lacks `dashboard.view_executive` for this business/branch.
      if (!scope.isExecutiveAuthorized) return emptyStats;

      // 1. Headline numbers — server-enforced scope.
      const { data: rpcRaw, error: rpcErr } = await supabase.rpc(
        "get_executive_stats" as any,
        {
          _business_id: scope.businessId,
          _branch_id: scope.branchId,
          _kind: scope.kind,
        } as any,
      );
      if (rpcErr) {
        console.warn("[useExecutiveStats] get_executive_stats failed:", rpcErr.message);
        return emptyStats;
      }
      const rpc = (rpcRaw ?? {}) as {
        receivables?: number;
        payables?: number;
        cash_position?: number;
        customer_count?: number;
        employee_count?: number;
      };

      const now = new Date();
      const thisMonthStart = startOfMonth(now);
      const lastMonthStart = startOfMonth(subMonths(now, 1));

      // 2. Per-business scorecard rows + derived breakdowns.
      // STRICTLY scoped: filter by the active business AND, when in
      // branch_only mode, by the active branch_id. Leaks across
      // businesses or branches are no longer possible from this hook.
      const branchEq = scope.kind === "branch_only" ? scope.branchId : null;
      const applyBranch = (q: any) =>
        branchEq ? q.eq("branch_id", branchEq) : q;

      const bizP = supabase
        .from("businesses")
        .select("id, name")
        .eq("organization_id", orgId)
        .eq("id", scope.businessId);
      const contactP = supabase
        .from("contacts")
        .select("id, created_at, business_id, name, parent_contact:contacts!parent_contact_id(name)")
        .eq("organization_id", orgId)
        .eq("business_id", scope.businessId);
      const invP = applyBranch(
        supabase
          .from("invoices")
          .select("id, total, amount_paid, status, business_id, due_date, issue_date, contact_id, branch_id")
          .eq("organization_id", orgId)
          .eq("business_id", scope.businessId),
      );
      // expenses table has no branch_id; business-only and labelled as such in UI.
      const expP = supabase
        .from("expenses")
        .select("id, amount, status, business_id, description")
        .eq("organization_id", orgId)
        .eq("business_id", scope.businessId);
      const billP = applyBranch(
        supabase
          .from("bills")
          .select("id, total, amount_paid, status, business_id, branch_id")
          .eq("organization_id", orgId)
          .eq("business_id", scope.businessId),
      );
      // bank_accounts: business + (optionally) branch scoped.
      const bankP = applyBranch(
        supabase
          .from("bank_accounts")
          .select("id, current_balance, is_active, account_id, branch_id")
          .eq("organization_id", orgId)
          .eq("business_id", scope.businessId)
          .eq("is_active", true),
      );
      // employees: business-level only (HR not branch-keyed). Canonical
      // read model — never query `employees.is_active` directly; route
      // through v_employees_canonical.is_operationally_active so stats
      // and the directory always agree.
      const empP = (supabase as any)
        .from("v_employees_canonical")
        .select("id")
        .eq("organization_id", orgId)
        .eq("business_id", scope.businessId)
        .eq("is_operationally_active", true);


      const [bizRes, contactRes, invRes, expRes, billRes, bankRes, empRes] = await Promise.all([
        bizP, contactP, invP, expP, billP, bankP, empP,
      ]);

      const businesses = (bizRes.data || []).filter((b: any) => b);
      const contacts = (contactRes.data ?? []) as Array<{
        id: string;
        created_at: string;
        business_id: string | null;
        name: string;
        parent_contact: { name: string | null } | null;
      }>;
      const invoices = invRes.data || [];
      const expenses = (expRes.data || []).filter((e: any) => ["approved", "paid"].includes(e.status));
      const bills = (billRes.data || []).filter((b: any) => ["received", "partial", "overdue"].includes(b.status));
      const bankAccounts = bankRes.data || [];
      const employees = empRes.data || [];

      const totalCustomers = contacts.length;
      const newThisMonth = contacts.filter(c => new Date(c.created_at) >= thisMonthStart).length;
      const newLastMonth = contacts.filter(c => {
        const d = new Date(c.created_at);
        return d >= lastMonthStart && d < thisMonthStart;
      }).length;
      const customerGrowth = newLastMonth > 0
        ? ((newThisMonth - newLastMonth) / newLastMonth) * 100
        : newThisMonth > 0 ? 100 : 0;

      const allTimeFrom = "1900-01-01";
      const allTimeTo = format(now, "yyyy-MM-dd");
      // GL totals are business-scoped (branch dimension on JE lines is
      // not honoured by fetchGLTotals today — flagged as follow-up).
      const glTotals = await fetchGLTotals(orgId, allTimeFrom, allTimeTo);

      const outstandingInvoices = invoices.filter(i => ["sent", "viewed", "partial", "overdue"].includes(i.status));

      // Headline numbers come from the scope-enforced RPC. We retain
      // the client-side outstanding list because we still need it to
      // build per-debtor breakdowns and DSO.
      const cashPosition = Number(rpc.cash_position ?? 0);
      const totalReceivables = Number(rpc.receivables ?? 0);
      const totalPayables = Number(rpc.payables ?? 0);
      const totalRevenue = glTotals.revenue;
      const dso = totalRevenue > 0 ? (totalReceivables / totalRevenue) * 365 : 0;

      const paidInvoices = invoices.filter(i => i.status === "paid");
      const totalInvoiceCount = paidInvoices.length + outstandingInvoices.length;
      const collectionRate = totalInvoiceCount > 0 ? (paidInvoices.length / totalInvoiceCount) * 100 : 0;

      const employeeCount = Number(rpc.employee_count ?? employees.length);
      const revenuePerEmployee = employeeCount > 0 ? totalRevenue / employeeCount : 0;

      // Top debtors
      const debtorMap = new Map<string, { name: string; bizName: string; amount: number; maxOverdue: number }>();
      for (const inv of outstandingInvoices) {
        const contact = contacts.find(c => c.id === inv.contact_id);
        const biz = businesses.find(b => b.id === inv.business_id);
        const key = inv.contact_id || inv.id;
        const outstanding = inv.total - (inv.amount_paid || 0);
        const daysOverdue = inv.due_date ? Math.max(0, differenceInDays(now, new Date(inv.due_date))) : 0;
        const existing = debtorMap.get(key);
        if (existing) {
          existing.amount += outstanding;
          existing.maxOverdue = Math.max(existing.maxOverdue, daysOverdue);
        } else {
          debtorMap.set(key, {
            name: contact?.parent_contact?.name || contact?.name || "Unknown",
            bizName: biz?.name || "",
            amount: outstanding, maxOverdue: daysOverdue,
          });
        }
      }
      const topDebtors: TopDebtor[] = [...debtorMap.values()]
        .sort((a, b) => b.amount - a.amount).slice(0, 5)
        .map(d => ({ contactName: d.name, businessName: d.bizName, amount: d.amount, daysOverdue: d.maxOverdue }));

      // Expenses by category
      const catMap = new Map<string, number>();
      for (const exp of expenses) {
        const cat = exp.description || "Uncategorized";
        catMap.set(cat, (catMap.get(cat) || 0) + exp.amount);
      }
      const totalExp = expenses.reduce((s, e) => s + e.amount, 0);
      const expensesByCategory: ExpenseCategorySummary[] = [...catMap.entries()]
        .map(([category, amount]) => ({ category, amount, percentage: totalExp > 0 ? (amount / totalExp) * 100 : 0 }))
        .sort((a, b) => b.amount - a.amount);

      const scorecards: BusinessScorecard[] = businesses.map(biz => {
        const rev = paidInvoices.filter(i => i.business_id === biz.id).reduce((s, i) => s + i.total, 0);
        const exp = expenses.filter(e => e.business_id === biz.id).reduce((s, e) => s + e.amount, 0);
        const profit = rev - exp;
        const ar = outstandingInvoices.filter(i => i.business_id === biz.id).reduce((s, i) => s + (i.total - (i.amount_paid || 0)), 0);
        const custs = contacts.filter(c => c.business_id === biz.id).length;
        return {
          businessId: biz.id, businessName: biz.name,
          revenue: rev, expenses: exp, profit,
          margin: rev > 0 ? (profit / rev) * 100 : 0,
          customerCount: custs, outstandingAR: ar,
          isOperationalEstimate: true as const,
        };
      }).sort((a, b) => b.revenue - a.revenue);

      return {
        totalCustomers: Number(rpc.customer_count ?? totalCustomers),
        newCustomersThisMonth: newThisMonth,
        newCustomersLastMonth: newLastMonth, customerGrowth,
        businessScorecards: scorecards, totalPayables, totalReceivables,
        cashPosition, dso, collectionRate, employeeCount, revenuePerEmployee,
        topDebtors, expensesByCategory,
      };
    },
    enabled: !!orgId && !!scope.businessId && scope.isReady,
    staleTime: 30_000,
  });

  return { stats, isLoading };
}
