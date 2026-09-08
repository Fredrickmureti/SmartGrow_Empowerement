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
 * teller doesn't see executive portfolio charts.
 */
export type DashboardRole =
  | "executive"
  | "accountant"
  | "operations"
  | "lending"
  | "cashier"
  | "generic";

/**
 * Widget identifiers used by the role-layout filter. Keep names
 * stable — they are referenced from dashboards to decide whether to
 * render each tile.
 */
export type DashboardWidgetId =
  | "kpi"
  | "portfolioChart"
  | "recentActivity"
  | "bankBalance"
  | "arrearsAlerts"
  | "pendingApprovals"
  | "branchComparison"
  | "activityFeed"
  | "upcomingDeadlines"
  | "quickActions"
  | "aiInsights"
  // Per-app widget IDs so a teller with read access on Finance/Lending
  // doesn't see the full executive surface.
  | "finance.kpis"
  | "finance.journals"
  | "finance.bankBalances"
  | "lending.kpis"
  | "lending.portfolio"
  | "lending.arrears"
  | "lending.disbursements";

export interface DashboardComposition {
  // Module + permission gating
  hasFinance: boolean;
  hasLending: boolean;
  hasCollections: boolean;
  hasContacts: boolean;
  hasReports: boolean;

  // Widget visibility (module + permission + data presence combined)
  showBankBalance: boolean;
  showArrearsAlerts: boolean;
  showPendingApprovals: boolean;
  showBranchComparison: boolean;
  showExecutive: boolean;
  showAIInsights: boolean;
  showUpcomingDeadlines: boolean;

  // Data-state signals
  isNewTenant: boolean;
  setupGaps: Array<
    "bank" | "clients" | "coa"
  >;

  /** Role preset derived from permissions. */
  role: DashboardRole;
  /**
   * Widget allow-list for the resolved role. Use
   * `allowsWidget("lending.kpis")` rather than reading raw flags so
   * callers don't need to know the role taxonomy.
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

  const installedFinance = isInstalled("finance");

  // Branch scope: in branch_only mode the probe must not count rows from
  // other branches — a branch user's setup-gap hints must reflect their own
  // branch, never institution-wide data.
  const probeBranchId = scope.kind === "branch_only" ? scope.branchId : null;

  const mkQuery = (table: string, enabled: boolean) => ({
    queryKey: ["composition-count", table, orgId, businessId, probeBranchId],
    enabled: enabled && scopeReady,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      if (!orgId || !businessId) return 0;
      let q = supabase
        .from(table as any)
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("business_id", businessId);
      if (probeBranchId) q = q.eq("branch_id", probeBranchId);
      const { count, error } = await q.limit(1);
      if (error) return 0;
      return count ?? 0;
    },
  });

  const { data: clientsCount } = useQuery(mkQuery("mf_clients", true));
  const { data: coaCount } = useQuery(mkQuery("accounts", installedFinance));


  return useMemo<DashboardComposition>(() => {
    const hasFinance = isInstalled("finance") && (perms.canViewFinancials || perms.canManageFinancials);
    const hasLending = isInstalled("lending") && (perms.canViewLoans || perms.canViewClients || perms.canViewApplications);
    const hasCollections = isInstalled("lending") && (perms.canViewCollections || perms.canManageCollections);
    const hasContacts = isInstalled("contacts") && (perms.canViewContacts || perms.canManageContacts);
    const hasReports = isInstalled("reports") && perms.canViewReports;

    const activeAccounts = (bankAccounts ?? []).filter((a: any) => a.is_active);
    const hasAnyBank = activeAccounts.length > 0;

    const setupGaps: DashboardComposition["setupGaps"] = [];
    if (hasFinance && !bankLoading && !hasAnyBank) setupGaps.push("bank");
    if (hasFinance && (coaCount ?? 1) === 0) setupGaps.push("coa");
    if ((clientsCount ?? 1) === 0) setupGaps.push("clients");

    // Role resolution — derived from current permissions / role
    // string. `perms.role` is the AppRole stored on user_roles.
    const roleStr = (perms as any).role as string | undefined;
    let role: DashboardRole = "generic";
    if (scope.isExecutiveAuthorized || roleStr === "owner" || roleStr === "super_admin") {
      role = "executive";
    } else if (roleStr === "accountant" || (perms.canManageFinancials && perms.canViewReports)) {
      role = "accountant";
    } else if (roleStr === "cashier" || (perms.canRecordRepayments && !perms.canManageClients)) {
      role = "cashier";
    } else if (perms.canManageApplications || perms.canManageClients) {
      role = "lending";
    } else if (hasCollections) {
      role = "operations";
    }

    // Per-role widget allow-list. Anything not listed is hidden for
    // that role even if its module/permission gate would otherwise
    // pass. `generic` is the permissive fallback.
    const ALLOW: Record<DashboardRole, Set<DashboardWidgetId>> = {
      executive: new Set([
        "kpi","portfolioChart","recentActivity","bankBalance","branchComparison",
        "upcomingDeadlines","quickActions","aiInsights","activityFeed","arrearsAlerts",
        "pendingApprovals",
        "finance.kpis","finance.journals","finance.bankBalances",
        "lending.kpis","lending.portfolio","lending.arrears","lending.disbursements",
      ]),
      accountant: new Set([
        "kpi","portfolioChart","recentActivity","bankBalance","arrearsAlerts",
        "pendingApprovals","upcomingDeadlines","quickActions",
        "activityFeed","aiInsights",
        "finance.kpis","finance.journals","finance.bankBalances",
        "lending.kpis","lending.portfolio",
      ]),
      operations: new Set([
        "kpi","recentActivity","arrearsAlerts","pendingApprovals",
        "upcomingDeadlines","quickActions","activityFeed",
        "finance.bankBalances",
        "lending.arrears","lending.portfolio",
      ]),
      lending: new Set([
        "kpi","recentActivity","arrearsAlerts","upcomingDeadlines",
        "quickActions","activityFeed",
        "lending.kpis","lending.portfolio","lending.arrears","lending.disbursements",
      ]),
      cashier: new Set([
        "kpi","recentActivity","quickActions","activityFeed",
        // Cashier intentionally has no finance.* / lending.* panels —
        // only Quick Actions remain visible on those dashboards.
      ]),
      generic: new Set([
        "kpi","portfolioChart","recentActivity","bankBalance","arrearsAlerts",
        "pendingApprovals","branchComparison",
        "upcomingDeadlines","quickActions","activityFeed","aiInsights",
        "finance.kpis","finance.journals","finance.bankBalances",
        "lending.kpis","lending.portfolio","lending.arrears","lending.disbursements",
      ]),
    };
    const allowed = ALLOW[role];

    return {
      hasFinance,
      hasLending,
      hasCollections,
      hasContacts,
      hasReports,
      showBankBalance: hasFinance,
      showArrearsAlerts: hasCollections,
      showPendingApprovals: hasFinance || hasLending,
      showBranchComparison: scope.kind === "all_branches" && scope.isConsolidatedAuthorized,
      showExecutive: scope.isExecutiveAuthorized,
      showAIInsights: hasAnyBank,
      showUpcomingDeadlines: hasLending || hasFinance,

      isNewTenant: setupGaps.length >= 2,
      setupGaps,
      role,
      allowsWidget: (id) => allowed.has(id),
    };
  }, [
    isInstalled, perms, scope, bankAccounts, bankLoading,
    clientsCount, coaCount,
  ]);
}