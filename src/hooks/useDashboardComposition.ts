/**
 * useDashboardComposition — single source of truth for which dashboard
 * widgets should render for the current user/tenant/scope.
 *
 * Resolves visibility from three signals so widget JSX in
 * `src/pages/Dashboard.tsx` stops sprinkling install + permission +
 * data-state checks inline:
 *
 *   1. Module-aware  — useInstalledApps()
 *   2. Role/perm-aware — usePermissions() + useDashboardScope()
 *   3. Data-aware    — useBankAccounts() emptiness
 *
 * Returns flat booleans. Callers render `{flags.showX ? <X /> : null}`,
 * keeping the JSX trivially auditable.
 */
import { useMemo } from "react";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { usePermissions } from "@/hooks/usePermissions";
import { useDashboardScope } from "@/hooks/useDashboardScope";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

/**
 * Dashboard role presets. Derived from the user's permission set —
 * NOT a manual switcher. Drives the per-role widget filter so a
 * cashier doesn't see executive P&L charts and an accountant sees
 * payroll/receivables prominently. See plan: Phase 5.
 */
export type DashboardRole =
  | "executive"
  | "accountant"
  | "operations"
  | "sales"
  | "cashier"
  | "generic";

/**
 * Widget identifiers used by the role-layout filter. Keep names
 * stable — they are referenced from `Dashboard.tsx` to decide
 * whether to render each tile.
 */
export type DashboardWidgetId =
  | "kpi"
  | "revenueChart"
  | "recentActivity"
  | "bankBalance"
  | "lowStock"
  | "creditAlerts"
  | "pendingApprovals"
  | "backorders"
  | "branchComparison"
  | "activityFeed"
  | "payrollSummary"
  | "upcomingDeadlines"
  | "quickActions"
  | "aiInsights"
  // Per-app widget IDs — used by FinanceDashboard / SalesDashboard so
  // a cashier with view permission on finance/sales doesn't see the
  // full executive surface. Roles outside the allow-list see only
  // Quick Actions on those pages.
  | "finance.kpis"
  | "finance.journals"
  | "finance.bankBalances"
  | "sales.kpis"
  | "sales.pipeline"
  | "sales.aging"
  | "sales.topCustomers"
  // Per-app widget IDs for inventory / hr / payroll / purchases so
  // cashier and sales roles don't see the executive-grade panels on
  // those module dashboards. Quick Actions still render for all roles.
  | "inventory.kpis"
  | "inventory.valuation"
  | "hr.kpis"
  | "hr.payrollSummary"
  | "payroll.kpis"
  | "purchases.kpis"
  | "purchases.aging";

export interface DashboardComposition {
  // Module + permission gating
  hasSales: boolean;
  hasPurchases: boolean;
  hasInventory: boolean;
  hasFinance: boolean;
  hasHR: boolean;
  hasContacts: boolean;
  hasReports: boolean;

  // Widget visibility (module + permission + data presence combined)
  showBankBalance: boolean;
  showLowStock: boolean;
  showCreditAlerts: boolean;
  showBackorders: boolean;
  showPendingApprovals: boolean;
  showBranchComparison: boolean;
  showExecutive: boolean;
  showAIInsights: boolean;
  showPayrollSummary: boolean;
  showUpcomingDeadlines: boolean;

  // Data-state signals
  isNewTenant: boolean;
  setupGaps: Array<
    "bank" | "customers" | "products" | "coa" | "employees"
  >;

  /** Role preset derived from permissions. */
  role: DashboardRole;
  /**
   * Widget allow-list for the resolved role. Use
   * `allowsWidget("payrollSummary")` rather than reading raw flags
   * so callers don't need to know the role taxonomy.
   */
  allowsWidget: (id: DashboardWidgetId) => boolean;
}

export function useDashboardComposition(): DashboardComposition {
  const { isInstalled } = useInstalledApps();
  const perms = usePermissions();
  const scope = useDashboardScope();
  const { accounts: bankAccounts, isLoading: bankLoading } = useBankAccounts();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  // Cheap HEAD-count probes for setup-gap detection. Each query is
  // gated on the relevant module being installed so we don't issue
  // wasted requests for non-installed apps.
  const orgId = currentOrg?.id ?? null;
  const businessId = currentBusiness?.id ?? null;
  const scopeReady = !!orgId && !!businessId;

  const installedContacts = isInstalled("contacts");
  const installedInventory = isInstalled("inventory");
  const installedFinance = isInstalled("finance");
  const installedHR = isInstalled("hr") || isInstalled("employees");

  const mkQuery = (table: string, enabled: boolean) => ({
    queryKey: ["composition-count", table, orgId, businessId],
    enabled: enabled && scopeReady,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      if (!orgId || !businessId) return 0;
      const { count, error } = await supabase
        .from(table as any)
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .limit(1);
      if (error) return 0;
      return count ?? 0;
    },
  });

  const { data: customersCount } = useQuery(mkQuery("contacts", installedContacts));
  const { data: productsCount } = useQuery(mkQuery("products", installedInventory));
  const { data: coaCount } = useQuery(mkQuery("accounts", installedFinance));
  const { data: employeesCount } = useQuery(mkQuery("employees", installedHR));

  return useMemo<DashboardComposition>(() => {
    const hasFinance = isInstalled("finance") && (perms.canViewFinancials || perms.canManageFinancials);
    const hasSales = isInstalled("sales") && (perms.canViewSales || perms.canManageSales);
    const hasPurchases = isInstalled("purchases") && (perms.canViewPurchases || perms.canManagePurchases || perms.canManageFinancials);
    const hasInventory = isInstalled("inventory") && (perms.canViewProducts || perms.canManageProducts);
    const hasHR = (isInstalled("hr") || isInstalled("employees")) && (perms.canViewPayroll || perms.canManagePayroll || perms.canRunPayroll || perms.canApprovePayroll || perms.canPostPayrollGL || perms.canPayPayroll);
    const hasContacts = isInstalled("contacts") && (perms.canViewContacts || perms.canManageContacts);
    const hasReports = isInstalled("reports") && perms.canViewReports;

    const activeAccounts = (bankAccounts ?? []).filter((a: any) => a.is_active);
    const hasAnyBank = activeAccounts.length > 0;

    const setupGaps: DashboardComposition["setupGaps"] = [];
    if (hasFinance && !bankLoading && !hasAnyBank) setupGaps.push("bank");
    if (hasFinance && (coaCount ?? 1) === 0) setupGaps.push("coa");
    if (hasContacts && (customersCount ?? 1) === 0) setupGaps.push("customers");
    if (hasInventory && (productsCount ?? 1) === 0) setupGaps.push("products");
    if (hasHR && (employeesCount ?? 1) === 0) setupGaps.push("employees");

    // Role resolution — derived from current permissions / role
    // string. `perms.role` is the AppRole stored on user_roles;
    // we fold legacy roles into the canonical six presets.
    const roleStr = (perms as any).role as string | undefined;
    let role: DashboardRole = "generic";
    if (scope.isExecutiveAuthorized || roleStr === "owner" || roleStr === "super_admin") {
      role = "executive";
    } else if (roleStr === "accountant" || (perms.canManageFinancials && perms.canViewReports)) {
      role = "accountant";
    } else if (roleStr === "cashier") {
      role = "cashier";
    } else if (hasSales && !hasFinance && !hasInventory) {
      role = "sales";
    } else if (hasInventory || hasPurchases) {
      role = "operations";
    }

    // Per-role widget allow-list. Anything not listed is hidden for
    // that role even if its module/permission gate would otherwise
    // pass. `generic` is the permissive fallback.
    const ALLOW: Record<DashboardRole, Set<DashboardWidgetId>> = {
      executive: new Set([
        "kpi","revenueChart","recentActivity","bankBalance","branchComparison",
        "upcomingDeadlines","payrollSummary","quickActions","aiInsights","activityFeed",
        "finance.kpis","finance.journals","finance.bankBalances",
        "sales.kpis","sales.pipeline","sales.aging","sales.topCustomers",
        "inventory.kpis","inventory.valuation",
        "hr.kpis","hr.payrollSummary","payroll.kpis",
        "purchases.kpis","purchases.aging",
      ]),
      accountant: new Set([
        "kpi","revenueChart","recentActivity","bankBalance","creditAlerts",
        "pendingApprovals","payrollSummary","upcomingDeadlines","quickActions",
        "activityFeed","aiInsights",
        "finance.kpis","finance.journals","finance.bankBalances",
        "sales.kpis","sales.pipeline","sales.aging","sales.topCustomers",
        "inventory.valuation",
        "hr.payrollSummary","payroll.kpis",
        "purchases.kpis","purchases.aging",
      ]),
      operations: new Set([
        "kpi","recentActivity","lowStock","backorders","pendingApprovals",
        "upcomingDeadlines","quickActions","activityFeed",
        "finance.bankBalances",
        "sales.pipeline",
        "inventory.kpis","inventory.valuation",
        "hr.kpis",
        "purchases.kpis","purchases.aging",
      ]),
      sales: new Set([
        "kpi","revenueChart","recentActivity","creditAlerts","upcomingDeadlines",
        "quickActions","activityFeed",
        "sales.kpis","sales.pipeline","sales.aging","sales.topCustomers",
        "inventory.kpis",
      ]),
      cashier: new Set([
        "kpi","recentActivity","quickActions","activityFeed",
        // Cashier intentionally has no finance.* / sales.* / inventory.* /
        // hr.* / payroll.* / purchases.* widgets — only Quick Actions
        // remain visible on those dashboards.
      ]),
      generic: new Set([
        "kpi","revenueChart","recentActivity","bankBalance","lowStock","creditAlerts",
        "pendingApprovals","backorders","branchComparison","payrollSummary",
        "upcomingDeadlines","quickActions","activityFeed","aiInsights",
        "finance.kpis","finance.journals","finance.bankBalances",
        "sales.kpis","sales.pipeline","sales.aging","sales.topCustomers",
        "inventory.kpis","inventory.valuation",
        "hr.kpis","hr.payrollSummary","payroll.kpis",
        "purchases.kpis","purchases.aging",
      ]),
    };
    const allowed = ALLOW[role];

    return {
      hasSales,
      hasPurchases,
      hasInventory,
      hasFinance,
      hasHR,
      hasContacts,
      hasReports,
      showBankBalance: hasFinance,
      showLowStock: hasInventory,
      showCreditAlerts: hasSales || hasContacts,
      showBackorders: hasInventory && hasSales,
      showPendingApprovals: hasHR || hasFinance || hasPurchases,
      showBranchComparison: scope.kind === "all_branches" && scope.isConsolidatedAuthorized,
      showExecutive: scope.isExecutiveAuthorized,
      showAIInsights: hasAnyBank,
      showPayrollSummary: hasHR && (employeesCount ?? 0) > 0,
      showUpcomingDeadlines: hasSales || hasPurchases || hasHR || hasFinance,

      isNewTenant: setupGaps.length >= 2,
      setupGaps,
      role,
      allowsWidget: (id) => allowed.has(id),
    };
  }, [
    isInstalled, perms, scope, bankAccounts, bankLoading,
    customersCount, productsCount, coaCount, employeesCount,
  ]);
}