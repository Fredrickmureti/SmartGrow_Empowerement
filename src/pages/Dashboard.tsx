import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useDashboardStats } from "@/hooks/useDashboardStats";
import { useDashboardAnalytics } from "@/hooks/useDashboardAnalytics";
import { useCurrency } from "@/hooks/useCurrency";
import { useViewCurrencyPreference } from "@/hooks/useViewCurrencyPreference";
import { usePendingBusinessSetup } from "@/hooks/usePendingBusinessSetup";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import { Navigate } from "react-router-dom";
import { DashboardAppLayout as DashboardLayout } from "@/apps/dashboard";
import { PageHeader, PageBody } from "@/design-system";
import { CurrencyToggle } from "@/components/common/CurrencyToggle";
import { DashboardScopeBadge } from "@/components/dashboard/DashboardScopeBadge";
import { ScopeBadge } from "@/components/common/ScopeBadge";
import { BankBalanceWidget } from "@/components/dashboard/BankBalanceWidget";
import { SalesSummaryWidget } from "@/components/dashboard/SalesSummaryWidget";
import { CashFlowWidget } from "@/components/dashboard/CashFlowWidget";
import { ProfitMarginWidget } from "@/components/dashboard/ProfitMarginWidget";
import { ExpenseCategoriesWidget } from "@/components/dashboard/ExpenseCategoriesWidget";
import { ReceivablesWidget } from "@/components/dashboard/ReceivablesWidget";
import { LowStockWidget } from "@/components/dashboard/LowStockWidget";
import { CreditAlertWidget } from "@/components/dashboard/CreditAlertWidget";
import { supabase } from "@/integrations/supabase/client";
import { PendingApprovalsWidget } from "@/components/dashboard/PendingApprovalsWidget";
import { BackorderWidget } from "@/components/dashboard/BackorderWidget";
import { BranchComparisonWidget } from "@/components/dashboard/BranchComparisonWidget";
import { ExecutiveDashboard } from "@/components/dashboard/ExecutiveDashboard";

import { AIInsightsWidget } from "@/components/ai/AIInsightsWidget";
import { AISuggestionsWidget } from "@/components/ai/AISuggestionsWidget";
import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
import { SetupWizard } from "@/components/onboarding/SetupWizard";

import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { DashboardCommandStrip } from "@/components/dashboard/DashboardCommandStrip";
import { DashboardSetupGuide } from "@/components/dashboard/DashboardSetupGuide";
import { UpcomingDeadlinesWidget } from "@/components/dashboard/UpcomingDeadlinesWidget";
import { PayrollSummaryWidget } from "@/components/dashboard/PayrollSummaryWidget";
import { QuickActions } from "@/components/home/QuickActions";
import { DashboardCreateBar } from "@/components/dashboard/DashboardCreateBar";
import { useDashboardComposition } from "@/hooks/useDashboardComposition";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Building2, LogOut, User, TrendingUp, TrendingDown, FileText, Receipt, ArrowUpRight, ArrowDownRight, Coins, LayoutDashboard, ShoppingCart, Wallet, PieChart, Users, Sparkles, Package, GitCompare } from "lucide-react";
import { CreateOrganizationDialog } from "@/components/organization/CreateOrganizationDialog";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const { organizations, currentOrg, isLoading: orgLoading, refreshOrganizations, createOrganization } = useOrganization();
  const { currentBusiness, businesses } = useBusinesses();
  const { stats, isLoading: statsLoading } = useDashboardStats();
  const { analytics, isLoading: analyticsLoading } = useDashboardAnalytics();
  const { formatCurrency, convertCurrency, baseCurrency, getCurrencySymbol, isReady: currencyReady } = useCurrency();
  const { viewCurrency, setViewCurrency } = useViewCurrencyPreference();
  // Pass user metadata to enable server-side data access
  const { getPendingSetup, clearPendingSetup } = usePendingBusinessSetup(user?.user_metadata);
  // Platform-admin probe — used to bounce SaaS operators out of the customer
  // dashboard. They land here only if they clicked a stale link; the empty
  // state below is for tenant customers and would conflate the two roles.
  const { isPlatformAdmin, isChecking: adminChecking } = usePlatformAdmin();
  // Module + permission awareness — drives which widgets/tabs render so the
  // dashboard stops showing Low Stock to tenants without Inventory installed,
  // Payroll widgets to tenants without HR, etc. (See dashboard audit plan.)
  const composition = useDashboardComposition();
  const {
    hasSales,
    hasPurchases,
    hasInventory,
    hasFinance,
    hasHR,
    showBankBalance,
    showLowStock,
    showCreditAlerts,
    showBackorders,
    showPendingApprovals,
    showBranchComparison,
    showAIInsights,
    showPayrollSummary,
    showUpcomingDeadlines,
    isNewTenant,
    setupGaps,
    role,
    allowsWidget,
  } = composition;
  const { toast } = useToast();
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const navigate = useNavigate();

  const isLoading = orgLoading || !currencyReady || adminChecking;

  // NOTE: Dashboard does NOT auto-create organizations from pending signup metadata.
  // Onboarding is the single authoritative provisioning path (see OnboardingSetup +
  // OnboardingGuard). Having two creation paths caused duplicate-key 409 races
  // during signup. If a user lands here without an org, OnboardingGuard will route
  // them to /onboarding-setup or /select-organization as appropriate.

  // Show setup wizard for new organizations that haven't completed it
  useEffect(() => {
    if (currentOrg && (currentOrg as any).setup_wizard_completed === false) {
      setShowSetupWizard(true);
    }
  }, [currentOrg]);

  const displayCurrency = viewCurrency || baseCurrency;

  const displayAmount = (amount: number) => {
    if (displayCurrency !== baseCurrency) {
      const converted = convertCurrency(amount, baseCurrency, displayCurrency);
      if (converted === null) return "—";
      return formatCurrency(converted, displayCurrency);
    }
    return formatCurrency(amount, baseCurrency);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading your workspace...</p>
        </div>
      </div>
    );
  }

  // Platform admin without a tenant: do NOT render the customer "Create
  // Organization" empty state. SaaS operators belong in /admin-management.
  // The conflation of these two roles was the original bug we are fixing.
  if (isPlatformAdmin && organizations.length === 0) {
    return <Navigate to="/admin-management" replace />;
  }

  // No organizations - show onboarding (tenant customers only)
  if (organizations.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card">
          <div className="container flex h-16 items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
                <svg className="w-5 h-5 text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
                </svg>
              </div>
              <span className="font-bold text-lg">AccrualFlow</span>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <User className="h-4 w-4" />
                {user?.email}
              </div>
              <Button variant="ghost" size="sm" onClick={signOut}>
                <LogOut className="h-4 w-4 mr-2" />
                Sign out
              </Button>
            </div>
          </div>
        </header>
        <main className="container py-16">
          <div className="max-w-2xl mx-auto text-center">
            <div className="mb-8">
              <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6">
                <Building2 className="w-10 h-10 text-primary" />
              </div>
              <h1 className="text-3xl font-bold mb-4">Welcome to AccrualFlow!</h1>
              <p className="text-lg text-muted-foreground">
                Let's get started by setting up your first organization.
              </p>
            </div>
            <Card className="text-left">
              <CardHeader>
                <CardTitle>Create Your Organization</CardTitle>
                <CardDescription>
                  An organization represents your business or company.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => setShowCreateOrg(true)} className="w-full" size="lg">
                  <Plus className="mr-2 h-5 w-5" />
                  Create Organization
                </Button>
              </CardContent>
            </Card>
          </div>
        </main>
        <CreateOrganizationDialog open={showCreateOrg} onOpenChange={setShowCreateOrg} onSuccess={refreshOrganizations} />
      </div>
    );
  }

  const getActivityIcon = (type: string) => {
    switch (type) {
      case "invoice": return <FileText className="h-4 w-4 text-blue-600" />;
      case "payment": return <Coins className="h-4 w-4 text-green-600" />;
      case "expense": return <Receipt className="h-4 w-4 text-red-600" />;
      case "bill": return <Receipt className="h-4 w-4 text-orange-600" />;
      default: return <FileText className="h-4 w-4" />;
    }
  };

  const getActivityBadge = (type: string) => {
    switch (type) {
      case "invoice": return <Badge variant="secondary" className="bg-blue-100 text-blue-800">Invoice</Badge>;
      case "payment": return <Badge variant="secondary" className="bg-green-100 text-green-800">Payment</Badge>;
      case "expense": return <Badge variant="secondary" className="bg-red-100 text-red-800">Expense</Badge>;
      case "bill": return <Badge variant="secondary" className="bg-orange-100 text-orange-800">Bill</Badge>;
      default: return <Badge variant="secondary">{type}</Badge>;
    }
  };

  const chartData = stats.monthlyRevenue.map((rev, i) => ({
    month: rev.month,
    revenue: rev.amount,
    expenses: stats.monthlyExpenses[i]?.amount || 0,
  }));

  const currencySymbol = getCurrencySymbol(displayCurrency);

  // Cross-company consolidation lives at /reports/consolidation (Odoo-style).
  // The dashboard always renders the active company; never an aggregated view.

  return (
    <DashboardLayout>
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="Welcome back! Here's an overview of your business."
        actions={<CurrencyToggle />}
      />
      <PageBody fullWidth className="gap-4 sm:gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <DashboardScopeBadge />
          <ScopeBadge declareScope={false} />
          {role !== "generic" ? (
            <Badge variant="outline" className="capitalize">
              Viewing as {role}
            </Badge>
          ) : null}
        </div>



        {/*
          Command strip — surfaces the highest-signal "needs attention"
          counts (overdue invoices, bills due soon, low stock, unreconciled
          bank txns) as deep-link chips that preserve dashboard scope. Hidden
          entirely when nothing is actionable so the dashboard stays calm.
        */}
        <DashboardCommandStrip
          hasSales={hasSales}
          hasPurchases={hasPurchases}
          hasInventory={hasInventory}
          hasFinance={hasFinance}
        />

        {/* New-tenant setup guide — promoted above the widget wall when
            the workspace is missing foundational data (bank, customers,
            invoices). Replaces zeroed widgets with concrete CTAs. */}
        {isNewTenant ? <DashboardSetupGuide gaps={setupGaps} /> : null}

        {/* Verb-led Create bar — primary transactional actions, gated by
            install + permission. Sits between the setup guide and the
            tabs so any user (executive or operator) can start work in
            one click without diving through sidebars. */}
        <DashboardCreateBar />

        {/* Tabbed Dashboard */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4 sm:space-y-6">
          <TabsList className="flex flex-wrap h-auto gap-1 p-1 w-full sm:w-auto">
            <TabsTrigger value="overview" className="gap-1.5 text-xs sm:text-sm">
              <LayoutDashboard className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              <span className="hidden sm:inline">Overview</span>
            </TabsTrigger>
            {hasSales && allowsWidget("revenueChart") ? (
              <TabsTrigger value="sales" className="gap-1.5 text-xs sm:text-sm">
                <ShoppingCart className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">Sales</span>
              </TabsTrigger>
            ) : null}
            {hasFinance && (role === "executive" || role === "accountant") ? (
              <TabsTrigger value="cashflow" className="gap-1.5 text-xs sm:text-sm">
                <Wallet className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">Cash Flow</span>
              </TabsTrigger>
            ) : null}
            {hasPurchases && role !== "cashier" && role !== "sales" ? (
              <TabsTrigger value="expenses" className="gap-1.5 text-xs sm:text-sm">
                <PieChart className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">Expenses</span>
              </TabsTrigger>
            ) : null}
            {(hasSales || hasPurchases) && role !== "cashier" && role !== "operations" ? (
              <TabsTrigger value="receivables" className="gap-1.5 text-xs sm:text-sm">
                <Users className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">Receivables</span>
              </TabsTrigger>
            ) : null}
          </TabsList>

          {statsLoading || analyticsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Overview Tab */}
              <TabsContent value="overview" className="space-y-4 sm:space-y-6">
                {allowsWidget("kpi") ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 2xl:grid-cols-4 gap-4">
                  <Card
                    onClick={() => navigate("/finance/reports/financial?period=current_month")}
                    role="link"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") navigate("/finance/reports/financial?period=current_month"); }}
                    className="cursor-pointer hover:shadow-md transition-shadow"
                  >
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardDescription className="text-xs sm:text-sm">Total Revenue</CardDescription>
                      <TrendingUp className="h-4 w-4 text-success flex-shrink-0" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold tabular-nums break-words text-success" title={displayAmount(stats.totalRevenue)}>{displayAmount(stats.totalRevenue)}</div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                        {stats.totalRevenueChange >= 0 ? <ArrowUpRight className="h-3 w-3 text-success" /> : <ArrowDownRight className="h-3 w-3 text-destructive" />}
                        <span className={stats.totalRevenueChange >= 0 ? "text-success" : "text-destructive"}>{Math.abs(stats.totalRevenueChange).toFixed(1)}%</span>
                        <span>vs last month</span>
                      </div>
                    </CardContent>
                  </Card>
                  <Card
                    onClick={() => navigate("/sales/invoices?status=overdue,sent,partial")}
                    role="link"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") navigate("/sales/invoices?status=overdue,sent,partial"); }}
                    className="cursor-pointer hover:shadow-md transition-shadow"
                  >
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardDescription className="text-xs sm:text-sm">Outstanding</CardDescription>
                      <FileText className="h-4 w-4 text-warning flex-shrink-0" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold tabular-nums break-words text-warning" title={displayAmount(stats.outstandingInvoices)}>{displayAmount(stats.outstandingInvoices)}</div>
                      <p className="text-xs text-muted-foreground mt-1">{stats.outstandingCount} invoice{stats.outstandingCount !== 1 ? "s" : ""} pending</p>
                    </CardContent>
                  </Card>
                  <Card
                    onClick={() => navigate("/finance/reports/financial?period=current_month")}
                    role="link"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") navigate("/finance/reports/financial?period=current_month"); }}
                    className="cursor-pointer hover:shadow-md transition-shadow"
                  >
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardDescription className="text-xs sm:text-sm">Expenses</CardDescription>
                      <TrendingDown className="h-4 w-4 text-destructive flex-shrink-0" />
                    </CardHeader>
                    <CardContent>
                      <div className="text-xl font-bold tabular-nums break-words text-destructive" title={displayAmount(stats.totalExpenses)}>{displayAmount(stats.totalExpenses)}</div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                        {stats.totalExpensesChange >= 0 ? <ArrowUpRight className="h-3 w-3 text-destructive" /> : <ArrowDownRight className="h-3 w-3 text-success" />}
                        <span className={stats.totalExpensesChange >= 0 ? "text-destructive" : "text-success"}>{Math.abs(stats.totalExpensesChange).toFixed(1)}%</span>
                        <span>vs last month</span>
                      </div>
                    </CardContent>
                  </Card>
                  <Card
                    onClick={() => navigate("/finance/reports/financial?period=current_month")}
                    role="link"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") navigate("/finance/reports/financial?period=current_month"); }}
                    className="cursor-pointer hover:shadow-md transition-shadow"
                  >
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                      <CardDescription className="text-xs sm:text-sm">Net Profit</CardDescription>
                      <Coins className={`h-4 w-4 flex-shrink-0 ${stats.netProfit >= 0 ? "text-success" : "text-destructive"}`} />
                    </CardHeader>
                    <CardContent>
                      <div className={`text-xl font-bold tabular-nums break-words ${stats.netProfit >= 0 ? "text-success" : "text-destructive"}`} title={displayAmount(stats.netProfit)}>{displayAmount(stats.netProfit)}</div>
                      <p className="text-xs text-muted-foreground mt-1">All time</p>
                    </CardContent>
                  </Card>
                </div>
                ) : null}


                <div className="grid gap-4 sm:gap-6 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                  {allowsWidget("revenueChart") ? (
                  <Card className="md:col-span-2">
                    <CardHeader>
                      <CardTitle className="text-base sm:text-lg">Revenue vs Expenses</CardTitle>
                      <CardDescription>Last 6 months</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {chartData.some(d => d.revenue > 0 || d.expenses > 0) ? (
                        <div className="h-[200px] sm:h-[250px] min-w-0">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={chartData} margin={{ left: -10, right: 10 }}>
                              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                              <XAxis dataKey="month" className="text-xs" tick={{ fontSize: 10 }} />
                              <YAxis className="text-xs" tick={{ fontSize: 10 }} tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} width={50} />
                              <Tooltip formatter={(value: number) => displayAmount(value)} contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }} />
                              <Area type="monotone" dataKey="revenue" stroke="hsl(142, 76%, 36%)" fill="hsl(142, 76%, 36%, 0.2)" name="Revenue" />
                              <Area type="monotone" dataKey="expenses" stroke="hsl(0, 84%, 60%)" fill="hsl(0, 84%, 60%, 0.2)" name="Expenses" />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center h-[200px] sm:h-[250px] text-muted-foreground">No data yet</div>
                      )}
                    </CardContent>
                  </Card>
                  ) : null}
                  {allowsWidget("recentActivity") ? (
                  <Card className="md:col-span-2 lg:col-span-1">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base sm:text-lg">Recent Activity</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {stats.recentActivity.length === 0 ? (
                        <div className="flex items-center justify-center h-32 text-muted-foreground">No recent activity</div>
                      ) : (
                        <div className="space-y-3">
                          {stats.recentActivity.slice(0, 5).map((activity) => (
                            <div key={activity.id} className="flex items-center gap-2 sm:gap-3">
                              <div className="flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center rounded-full bg-muted flex-shrink-0">{getActivityIcon(activity.type)}</div>
                              <div className="flex-1 min-w-0">
                                <p className="text-xs sm:text-sm font-medium truncate">{activity.description}</p>
                                <p className="text-[10px] sm:text-xs text-muted-foreground">{format(new Date(activity.date), "MMM d")}</p>
                              </div>
                              <p className={`text-xs sm:text-sm font-medium flex-shrink-0 ${activity.type === "expense" || activity.type === "bill" ? "text-destructive" : activity.type === "payment" ? "text-success" : ""}`}>
                                {displayAmount(activity.amount)}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                  ) : null}
                  {showBankBalance && allowsWidget("bankBalance") ? <BankBalanceWidget /> : null}
                  {showLowStock && allowsWidget("lowStock") ? <LowStockWidget /> : null}
                  {showCreditAlerts && allowsWidget("creditAlerts") ? <CreditAlertWidget /> : null}
                  {showPendingApprovals && allowsWidget("pendingApprovals") ? <PendingApprovalsWidget /> : null}
                  {showBackorders && allowsWidget("backorders") ? <BackorderWidget /> : null}
                  {showPayrollSummary && allowsWidget("payrollSummary") ? <PayrollSummaryWidget /> : null}
                  {showUpcomingDeadlines && allowsWidget("upcomingDeadlines") ? (
                    <UpcomingDeadlinesWidget hasSales={hasSales} hasPurchases={hasPurchases} hasHR={hasHR} />
                  ) : null}
                  {allowsWidget("activityFeed") ? <ActivityFeed /> : null}
                  {showBranchComparison && allowsWidget("branchComparison") ? <BranchComparisonWidget /> : null}
                </div>

                {/*
                  Quick Actions — uses the shared QuickActions component so the
                  dashboard, the home launcher, and any future surface share ONE
                  source of truth for app-install + permission + correct-path
                  routing. The previous inline buttons hard-coded /invoices,
                  /contacts, /expenses which 404 because the real routes live
                  under /sales/*, /contacts-app/*, /purchases/*.
                */}
                {allowsWidget("quickActions") ? <QuickActions /> : null}
              </TabsContent>

              {/* Sales Tab */}
              <TabsContent value="sales">
                {analytics?.salesSummary && (
                  <SalesSummaryWidget data={analytics.salesSummary} displayCurrency={displayCurrency} />
                )}
              </TabsContent>

              {/* Cash Flow Tab */}
              <TabsContent value="cashflow">
                {analytics?.cashFlow && (
                  <CashFlowWidget data={analytics.cashFlow} cashBalance={analytics.cashBalance} displayCurrency={displayCurrency} />
                )}
              </TabsContent>

              {/* Expenses Tab */}
              <TabsContent value="expenses">
                {analytics?.expenseCategories && (
                  <ExpenseCategoriesWidget data={analytics.expenseCategories} displayCurrency={displayCurrency} />
                )}
              </TabsContent>

              {/* Receivables Tab */}
              <TabsContent value="receivables">
                {analytics?.receivables && analytics?.payables && (
                  <ReceivablesWidget receivables={analytics.receivables} payables={analytics.payables} displayCurrency={displayCurrency} />
                )}
              </TabsContent>
            </>
          )}
        </Tabs>

        {/* Onboarding Checklist — keeps fine-grained progress underneath
            the DashboardSetupGuide. The setup guide handles the loud,
            top-of-page CTAs for brand-new tenants. */}
        <OnboardingChecklist />

        {/* AI Insights — only meaningful once the tenant has live data. */}
        {showAIInsights && allowsWidget("aiInsights") ? (
          <div className="grid gap-4 sm:gap-6 grid-cols-1 md:grid-cols-2">
            <AIInsightsWidget />
            <AISuggestionsWidget
              pendingInvoices={stats?.outstandingCount ?? 0}
              overdueAmount={analytics?.receivables?.totalOverdue || 0}
            />
          </div>
        ) : null}
      </PageBody>



      {/* Setup Wizard for new organizations */}
      <SetupWizard 
        open={showSetupWizard} 
        onOpenChange={setShowSetupWizard}
        onComplete={() => {
          setShowSetupWizard(false);
          refreshOrganizations();
        }}
      />
    </DashboardLayout>
  );
}
