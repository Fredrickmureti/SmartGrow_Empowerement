import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { ScrollableTabsList } from "@/components/ui/scrollable-tabs-list";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { PermissionGate, useCanEdit } from "@/components/common/PermissionGate";
import { DrillDownDialog, type DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { useFiscalPeriodDetail, type AccountMovement } from "@/hooks/useFiscalPeriodDetail";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import { useCurrency } from "@/hooks/useCurrency";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { BranchReadOnlyBanner } from "@/components/finance/BranchReadOnlyBanner";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  ArrowLeft, ArrowRight, Lock, Unlock, Loader2, TrendingUp, TrendingDown,
  DollarSign, BookOpen, FileText, Receipt, CreditCard, Wallet,
  CheckCircle2, XCircle, AlertTriangle, BarChart3, Edit3, Save,
  RefreshCw, ChevronLeft, ChevronRight, ExternalLink, Building2,
  Landmark, Package, PieChart, ClipboardCheck, LinkIcon, Shield,
  ArrowUpRight, ArrowDownRight,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

const ACCOUNT_TYPE_COLORS: Record<string, string> = {
  income: "hsl(var(--primary))",
  expense: "hsl(var(--destructive))",
  asset: "hsl(var(--accent-foreground))",
  liability: "hsl(var(--muted-foreground))",
  equity: "hsl(var(--secondary-foreground))",
};

function ChangeIndicator({ value, suffix = "%" }: { value: number; suffix?: string }) {
  if (value === 0) return <span className="text-xs text-muted-foreground">—</span>;
  const isPositive = value > 0;
  const Icon = isPositive ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${isPositive ? "text-primary" : "text-destructive"}`}>
      <Icon className="h-3 w-3" />
      {Math.abs(value).toFixed(1)}{suffix}
    </span>
  );
}

export default function FiscalPeriodDetail() {
  const { periodId } = useParams<{ periodId: string }>();
  const navigate = useNavigate();
  const { period, detail, isLoading, refresh, adjacentPeriods } = useFiscalPeriodDetail(periodId);
  const { closePeriod, reopenPeriod } = useFiscalPeriods();
  const { formatCurrency } = useCurrency();
  const canEdit = useCanEdit("financials");
  const scope = useFinanceScope();
  const { allowed: canManagePeriods } = useFinancePermission("finance.manage_periods");
  // Mirrors the list page (FiscalPeriods.tsx): fiscal-period mutations are a
  // business-level action. HQ branch is the edit surface; only NON-HQ branches
  // are read-only. The DB trigger trg_fiscal_periods_no_branch_context still
  // backstops this on the server.
  const insideBranchContext = scope.isBranchScopedReadOnly;
  const canEditPeriods = canManagePeriods && !insideBranchContext;

  const [drillDown, setDrillDown] = useState<DrillDownConfig | null>(null);
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const handleDrillDown = (acct: AccountMovement) => {
    if (!period) return;
    setDrillDown({
      title: `${acct.account_code} — ${acct.account_name}`,
      accountId: acct.account_id,
      accountType: acct.account_type,
      startDate: period.start_date,
      endDate: period.end_date,
    });
  };

  const handleClose = async () => {
    if (!period) return;
    setActionLoading(true);
    try {
      await closePeriod.mutateAsync({ periodId: period.id });
    } finally {
      setActionLoading(false);
    }
  };

  const handleReopen = async () => {
    if (!period) return;
    setActionLoading(true);
    try {
      await reopenPeriod.mutateAsync(period.id);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveNotes = async () => {
    if (!period) return;
    setSavingNotes(true);
    const { error } = await supabase
      .from("fiscal_periods")
      .update({ notes })
      .eq("id", period.id);
    setSavingNotes(false);
    if (error) {
      toast.error("Failed to save notes");
    } else {
      toast.success("Notes saved");
      setIsEditingNotes(false);
    }
  };

  const startEditNotes = () => {
    setNotes(period?.notes || "");
    setIsEditingNotes(true);
  };

  if (isLoading) {
    return (
      <>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </>
    );
  }

  if (!period) {
    return (
      <>
        <div className="text-center py-20 text-muted-foreground">
          <p>Period not found</p>
          <Button variant="link" onClick={() => navigate("/finance/fiscal-periods")}>Back to Fiscal Periods</Button>
        </div>
      </>
    );
  }

  const { financials, transactionCounts, accountBreakdown, topAccounts, recentEntries, closeReadiness, subledger, budgetComparison, assetSummary, priorPeriod, bankSummary } = detail;
  const isOpen = period.status === "open";
  const isClosed = period.status === "closed";

  // Group accounts by type
  const groupedAccounts = accountBreakdown.reduce<Record<string, AccountMovement[]>>((acc, a) => {
    if (!acc[a.account_type]) acc[a.account_type] = [];
    acc[a.account_type].push(a);
    return acc;
  }, {});
  const typeOrder = ["income", "expense", "asset", "liability", "equity"];
  const typeLabels: Record<string, string> = {
    income: "Income", expense: "Expenses", asset: "Assets",
    liability: "Liabilities", equity: "Equity",
  };

  // Chart data
  const chartData = topAccounts.map((a) => ({
    name: a.account_code,
    fullName: a.account_name,
    value: Math.abs(a.net),
    type: a.account_type,
  }));

  // Report links
  const reportLinks = [
    { label: "Trial Balance", icon: BookOpen, href: `/finance/reports/trial-balance?as_of=${period.end_date}` },
    { label: "General Ledger", icon: BookOpen, href: `/finance/reports/general-ledger?date_from=${period.start_date}&date_to=${period.end_date}` },
    { label: "Profit & Loss", icon: TrendingUp, href: `/finance/reports/financial?report=pl&date_from=${period.start_date}&date_to=${period.end_date}` },
    { label: "Balance Sheet", icon: DollarSign, href: `/finance/reports/financial?report=bs&date_to=${period.end_date}` },
    { label: "Cash Flow", icon: Wallet, href: `/finance/reports/cash-flow?date_from=${period.start_date}&date_to=${period.end_date}` },
    { label: "AR Aging", icon: FileText, href: `/finance/reports/aging?type=receivable&as_of=${period.end_date}` },
    { label: "AP Aging", icon: Receipt, href: `/finance/reports/aging?type=payable&as_of=${period.end_date}` },
    { label: "Journal Report", icon: BookOpen, href: `/finance/reports/journal-report?date_from=${period.start_date}&date_to=${period.end_date}` },
  ];

  // Health badge
  const healthLabel = closeReadiness.healthScore >= 80 ? "Ready" : closeReadiness.healthScore >= 50 ? "Needs Attention" : "Blockers";
  const healthColor = closeReadiness.healthScore >= 80 ? "text-primary" : closeReadiness.healthScore >= 50 ? "text-amber-500" : "text-destructive";

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <BranchReadOnlyBanner area="Fiscal Periods" permissionLabel="finance.manage_periods" />
        {/* Header */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Button variant="ghost" size="sm" className="w-fit -ml-2" onClick={() => navigate("/finance/fiscal-periods")}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Fiscal Periods
            </Button>
            <div className="flex items-center gap-1">
              {adjacentPeriods.prev && (
                <Button variant="ghost" size="sm" onClick={() => navigate(`/finance/fiscal-periods/${adjacentPeriods.prev!.id}`)}>
                  <ChevronLeft className="h-4 w-4" />
                  <span className="hidden sm:inline text-xs">{adjacentPeriods.prev.name}</span>
                </Button>
              )}
              {adjacentPeriods.next && (
                <Button variant="ghost" size="sm" onClick={() => navigate(`/finance/fiscal-periods/${adjacentPeriods.next!.id}`)}>
                  <span className="hidden sm:inline text-xs">{adjacentPeriods.next.name}</span>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">{period.name}</h1>
                <Badge variant={isOpen ? "default" : "outline"} className={isClosed ? "border-destructive text-destructive" : ""}>
                  {isOpen ? <Unlock className="h-3 w-3 mr-1" /> : <Lock className="h-3 w-3 mr-1" />}
                  {period.status.charAt(0).toUpperCase() + period.status.slice(1)}
                </Badge>
                <Badge variant="outline" className="capitalize text-xs">{period.period_type}</Badge>
                {isOpen && (
                  <Badge variant="outline" className={`text-xs ${healthColor}`}>
                    <Shield className="h-3 w-3 mr-1" />
                    {healthLabel} ({closeReadiness.healthScore})
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {format(new Date(period.start_date), "MMM d, yyyy")} — {format(new Date(period.end_date), "MMM d, yyyy")}
                {period.locked_at && (
                  <>
                    <span className="mx-2">•</span>
                    Closed {format(new Date(period.locked_at), "MMM d, yyyy 'at' h:mm a")}
                  </>
                )}
              </p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <RefreshButton
                queryKeyPrefixes={[
                  ['fiscal-period-detail'] as const,
                  ['journal-entries'] as const,
                ]}
                tooltip="Refresh period data"
              />
              <PermissionGate permission="manageFinancials">
                {isOpen && canEditPeriods && (
                  <Button variant="destructive" size="sm" onClick={handleClose} disabled={actionLoading}>
                    {actionLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Lock className="h-4 w-4 mr-1" />}
                    Close Period
                  </Button>
                )}
                {isClosed && canEditPeriods && (
                  <Button variant="outline" size="sm" onClick={handleReopen} disabled={actionLoading}>
                    {actionLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Unlock className="h-4 w-4 mr-1" />}
                    Reopen
                  </Button>
                )}
              </PermissionGate>
            </div>
          </div>
        </div>

        {/* Summary Cards — fluid auto-fit, no truncation, no breaking */}
        <div className="grid gap-3 sm:gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
          {[
            { label: "Revenue", value: financials.revenue, icon: TrendingUp, color: "text-primary", valueColor: "text-primary", change: priorPeriod.revenueChange },
            { label: "Expenses", value: financials.expenses, icon: TrendingDown, color: "text-destructive", valueColor: "text-destructive", change: priorPeriod.expenseChange },
            { label: "Net Income", value: financials.netIncome, icon: DollarSign, color: financials.netIncome >= 0 ? "text-primary" : "text-destructive", valueColor: financials.netIncome >= 0 ? "text-primary" : "text-destructive", change: priorPeriod.netIncomeChange },
            { label: "Gross Profit", value: financials.grossProfit, icon: PieChart, color: financials.grossProfit >= 0 ? "text-primary" : "text-destructive", valueColor: financials.grossProfit >= 0 ? "text-primary" : "text-destructive" },
            { label: "Total Debits", value: financials.totalDebits, icon: ArrowRight, color: "text-muted-foreground", valueColor: "text-foreground" },
            { label: "Total Credits", value: financials.totalCredits, icon: ArrowLeft, color: "text-muted-foreground", valueColor: "text-foreground" },
          ].map((card) => (
            <Card key={card.label} className="min-w-0">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1 p-3 sm:p-4">
                <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{card.label}</CardTitle>
                <card.icon className={`h-3.5 w-3.5 shrink-0 ${card.color}`} />
              </CardHeader>
              <CardContent className="p-3 sm:p-4 pt-0">
                <div className={`stat-value tabular-nums whitespace-nowrap ${card.valueColor}`}>
                  {formatCurrency(card.value)}
                </div>
                {card.change !== undefined && <ChangeIndicator value={card.change} />}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Tabs */}
        <Tabs defaultValue="overview" className="space-y-4">
          <ScrollableTabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
            <TabsTrigger value="entries">Journal Entries</TabsTrigger>
            <TabsTrigger value="subledgers">Subledgers</TabsTrigger>
            <TabsTrigger value="bank">Bank</TabsTrigger>
            {(assetSummary.additions > 0 || assetSummary.depreciationPosted > 0 || assetSummary.depreciationUnposted > 0) && (
              <TabsTrigger value="assets">Assets</TabsTrigger>
            )}
            {budgetComparison.length > 0 && (
              <TabsTrigger value="budget">Budget</TabsTrigger>
            )}
            <TabsTrigger value="reports">Reports</TabsTrigger>
            <TabsTrigger value="checklist">Close Checklist</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
          </ScrollableTabsList>

          {/* ── OVERVIEW TAB ── */}
          <TabsContent value="overview" className="space-y-4">
            {/* Quick Alerts */}
            {!closeReadiness.allClear && isOpen && (
              <Alert variant={closeReadiness.blockers > 0 ? "destructive" : "default"} className={closeReadiness.blockers === 0 ? "border-amber-500/30 bg-amber-500/5" : ""}>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{closeReadiness.blockers > 0 ? `${closeReadiness.blockers} Blocker(s)` : "Attention Needed"}</AlertTitle>
                <AlertDescription>
                  {closeReadiness.blockers > 0 && `${closeReadiness.blockers} blocking issue(s)`}
                  {closeReadiness.blockers > 0 && closeReadiness.warnings > 0 && " and "}
                  {closeReadiness.warnings > 0 && `${closeReadiness.warnings} warning(s)`}
                  {" "}found. Review the Close Checklist tab.
                </AlertDescription>
              </Alert>
            )}

            {/* Transaction Activity */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Transaction Activity</CardTitle>
                <CardDescription>Documents and entries in this period</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: "Posted JEs", value: transactionCounts.postedJournalEntries, icon: BookOpen, link: `/finance/journal-entries?dateFrom=${period.start_date}&dateTo=${period.end_date}&status=posted` },
                    { label: "Draft JEs", value: transactionCounts.draftJournalEntries, icon: BookOpen, variant: "warning" as const, link: `/finance/journal-entries?status=draft` },
                    { label: "Invoices", value: transactionCounts.invoices, icon: FileText, link: `/finance/invoices` },
                    { label: "Draft Invoices", value: transactionCounts.draftInvoices, icon: FileText, variant: "warning" as const },
                    { label: "Bills", value: transactionCounts.bills, icon: Receipt, link: `/finance/bills` },
                    { label: "Draft Bills", value: transactionCounts.draftBills, icon: Receipt, variant: "warning" as const },
                    { label: "Payments", value: transactionCounts.payments, icon: CreditCard, link: `/finance/payments` },
                    { label: "Expenses", value: transactionCounts.expenses, icon: Wallet, link: `/finance/expenses` },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className={`flex items-center gap-3 p-3 rounded-lg border bg-card ${item.link ? "cursor-pointer hover:bg-muted/50 transition-colors" : ""}`}
                      onClick={() => item.link && navigate(item.link)}
                    >
                      <item.icon className={`h-4 w-4 shrink-0 ${item.variant === "warning" ? "text-amber-500" : "text-muted-foreground"}`} />
                      <div className="min-w-0">
                        <div className="text-lg font-semibold">{item.value}</div>
                        <div className="text-xs text-muted-foreground truncate">{item.label}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Top Accounts Chart */}
            {chartData.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="h-4 w-4" /> Top Accounts by Activity
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-64 sm:h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                        <XAxis type="number" tickFormatter={(v: number) => formatCurrency(v)} tick={{ fontSize: 11 }} />
                        <YAxis type="category" dataKey="name" width={60} tick={{ fontSize: 11 }} />
                        <Tooltip
                          formatter={(value: number) => [formatCurrency(value), "Net Movement"]}
                          labelFormatter={(label: string) => {
                            const item = chartData.find((d) => d.name === label);
                            return item ? `${item.name} — ${item.fullName}` : label;
                          }}
                          contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }}
                        />
                        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                          {chartData.map((entry, i) => (
                            <Cell key={i} fill={ACCOUNT_TYPE_COLORS[entry.type] || "hsl(var(--muted-foreground))"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex flex-wrap gap-3 mt-3">
                    {Object.entries(typeLabels).map(([key, label]) => (
                      <div key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <div className="w-2.5 h-2.5 rounded-sm" style={{ background: ACCOUNT_TYPE_COLORS[key] }} />
                        {label}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── ACCOUNTS TAB ── */}
          <TabsContent value="accounts" className="space-y-4">
            {typeOrder.map((type) => {
              const accounts = groupedAccounts[type];
              if (!accounts || accounts.length === 0) return null;
              const typeTotal = accounts.reduce((s, a) => s + a.net, 0);
              return (
                <Card key={type}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">{typeLabels[type]}</CardTitle>
                      <span className="text-sm font-semibold">{formatCurrency(typeTotal)}</span>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto -mx-6">
                      <div className="inline-block min-w-full align-middle px-6">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Code</TableHead>
                              <TableHead>Account</TableHead>
                              <TableHead className="text-right">Debit</TableHead>
                              <TableHead className="text-right">Credit</TableHead>
                              <TableHead className="text-right">Net</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {accounts.map((acct) => (
                              <TableRow
                                key={acct.account_id}
                                className="cursor-pointer hover:bg-muted/70"
                                onClick={() => handleDrillDown(acct)}
                              >
                                <TableCell className="text-xs font-mono">{acct.account_code}</TableCell>
                                <TableCell className="text-sm font-medium">{acct.account_name}</TableCell>
                                <TableCell className="text-right text-sm">{formatCurrency(acct.total_debit)}</TableCell>
                                <TableCell className="text-right text-sm">{formatCurrency(acct.total_credit)}</TableCell>
                                <TableCell className={`text-right text-sm font-semibold ${acct.net < 0 ? "text-destructive" : ""}`}>
                                  {formatCurrency(acct.net)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {accountBreakdown.length === 0 && (
              <Card><CardContent className="py-12 text-center text-muted-foreground">No account activity in this period</CardContent></Card>
            )}
          </TabsContent>

          {/* ── JOURNAL ENTRIES TAB ── */}
          <TabsContent value="entries" className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Journal Entries</CardTitle>
                  <Button variant="outline" size="sm" onClick={() => navigate(`/finance/journal-entries?dateFrom=${period.start_date}&dateTo=${period.end_date}`)}>
                    View All <ExternalLink className="h-3 w-3 ml-1" />
                  </Button>
                </div>
                <CardDescription>
                  {transactionCounts.postedJournalEntries} posted, {transactionCounts.draftJournalEntries} draft — last 20 shown
                </CardDescription>
              </CardHeader>
              <CardContent>
                {recentEntries.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">No journal entries in this period</div>
                ) : (
                  <div className="overflow-x-auto -mx-6">
                    <div className="inline-block min-w-full align-middle px-6">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Number</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead className="hidden sm:table-cell">Description</TableHead>
                            <TableHead className="hidden md:table-cell">Source</TableHead>
                            <TableHead>Status</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {recentEntries.map((entry) => (
                            <TableRow
                              key={entry.id}
                              className="cursor-pointer hover:bg-muted/70"
                              onClick={() => navigate(`/finance/journal-entries?selected=${entry.id}`)}
                            >
                              <TableCell className="font-mono text-xs">{entry.entry_number}</TableCell>
                              <TableCell className="text-sm">{format(new Date(entry.entry_date), "MMM d")}</TableCell>
                              <TableCell className="text-sm hidden sm:table-cell max-w-[200px] truncate">{entry.description || "—"}</TableCell>
                              <TableCell className="text-sm hidden md:table-cell capitalize">{entry.source_type || "manual"}</TableCell>
                              <TableCell>
                                <Badge variant={entry.status === "posted" ? "default" : "secondary"} className="text-[10px]">
                                  {entry.status}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── SUBLEDGERS TAB ── */}
          <TabsContent value="subledgers" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* AR */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FileText className="h-4 w-4" /> Accounts Receivable
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between items-center p-3 rounded-lg bg-muted/50">
                    <span className="text-sm">Open Invoices</span>
                    <span className="font-semibold text-sm">{subledger.arCount}</span>
                  </div>
                  <div className="flex justify-between items-center p-3 rounded-lg bg-muted/50">
                    <span className="text-sm">Total Outstanding</span>
                    <span className="font-semibold text-sm">{formatCurrency(subledger.arTotal)}</span>
                  </div>
                  <div className="flex justify-between items-center p-3 rounded-lg bg-muted/50">
                    <span className="text-sm">Overdue</span>
                    <span className={`font-semibold text-sm ${subledger.arOverdue > 0 ? "text-destructive" : ""}`}>
                      {formatCurrency(subledger.arOverdue)}
                    </span>
                  </div>
                  <Button variant="outline" size="sm" className="w-full" onClick={() => navigate(`/finance/reports/aging?type=receivable&as_of=${period.end_date}`)}>
                    View AR Aging <ExternalLink className="h-3 w-3 ml-1" />
                  </Button>
                </CardContent>
              </Card>

              {/* AP */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Receipt className="h-4 w-4" /> Accounts Payable
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between items-center p-3 rounded-lg bg-muted/50">
                    <span className="text-sm">Open Bills</span>
                    <span className="font-semibold text-sm">{subledger.apCount}</span>
                  </div>
                  <div className="flex justify-between items-center p-3 rounded-lg bg-muted/50">
                    <span className="text-sm">Total Outstanding</span>
                    <span className="font-semibold text-sm">{formatCurrency(subledger.apTotal)}</span>
                  </div>
                  <div className="flex justify-between items-center p-3 rounded-lg bg-muted/50">
                    <span className="text-sm">Overdue</span>
                    <span className={`font-semibold text-sm ${subledger.apOverdue > 0 ? "text-destructive" : ""}`}>
                      {formatCurrency(subledger.apOverdue)}
                    </span>
                  </div>
                  <Button variant="outline" size="sm" className="w-full" onClick={() => navigate(`/finance/reports/aging?type=payable&as_of=${period.end_date}`)}>
                    View AP Aging <ExternalLink className="h-3 w-3 ml-1" />
                  </Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ── BANK TAB ── */}
          <TabsContent value="bank" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Landmark className="h-4 w-4" /> Bank & Reconciliation
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3 rounded-lg border bg-card text-center">
                    <div className="text-lg font-semibold">{bankSummary.totalTransactions}</div>
                    <div className="text-xs text-muted-foreground">Total Transactions</div>
                  </div>
                  <div className="p-3 rounded-lg border bg-card text-center">
                    <div className="text-lg font-semibold text-primary">{bankSummary.reconciled}</div>
                    <div className="text-xs text-muted-foreground">Reconciled</div>
                  </div>
                  <div className="p-3 rounded-lg border bg-card text-center">
                    <div className={`text-lg font-semibold ${bankSummary.unreconciled > 0 ? "text-amber-500" : "text-primary"}`}>{bankSummary.unreconciled}</div>
                    <div className="text-xs text-muted-foreground">Unreconciled</div>
                  </div>
                  <div className="p-3 rounded-lg border bg-card text-center">
                    <div className="text-lg font-semibold">{bankSummary.reconciledPercent.toFixed(0)}%</div>
                    <div className="text-xs text-muted-foreground">Reconciled %</div>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>Reconciliation Progress</span>
                    <span>{bankSummary.reconciledPercent.toFixed(0)}%</span>
                  </div>
                  <Progress value={bankSummary.reconciledPercent} className="h-2" />
                </div>

                <Button variant="outline" size="sm" onClick={() => navigate("/finance/reconciliation")}>
                  Go to Reconciliation <ExternalLink className="h-3 w-3 ml-1" />
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── FIXED ASSETS TAB ── */}
          {(assetSummary.additions > 0 || assetSummary.depreciationPosted > 0 || assetSummary.depreciationUnposted > 0) && (
            <TabsContent value="assets" className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Package className="h-4 w-4" /> Fixed Assets Activity
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="p-3 rounded-lg border bg-card text-center">
                      <div className="text-lg font-semibold">{assetSummary.additions}</div>
                      <div className="text-xs text-muted-foreground">Additions</div>
                    </div>
                    <div className="p-3 rounded-lg border bg-card text-center">
                      <div className="text-lg font-semibold">{assetSummary.disposals}</div>
                      <div className="text-xs text-muted-foreground">Disposals</div>
                    </div>
                    <div className="p-3 rounded-lg border bg-card text-center">
                      <div className="text-lg font-semibold text-primary">{assetSummary.depreciationPosted}</div>
                      <div className="text-xs text-muted-foreground">Depreciation Posted</div>
                    </div>
                    <div className="p-3 rounded-lg border bg-card text-center">
                      <div className={`text-lg font-semibold ${assetSummary.depreciationUnposted > 0 ? "text-amber-500" : ""}`}>{assetSummary.depreciationUnposted}</div>
                      <div className="text-xs text-muted-foreground">Depreciation Unposted</div>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" className="mt-4" onClick={() => navigate("/finance/fixed-assets")}>
                    Manage Fixed Assets <ExternalLink className="h-3 w-3 ml-1" />
                  </Button>
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* ── BUDGET TAB ── */}
          {budgetComparison.length > 0 && (
            <TabsContent value="budget" className="space-y-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <PieChart className="h-4 w-4" /> Budget vs Actual
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto -mx-6">
                    <div className="inline-block min-w-full align-middle px-6">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Code</TableHead>
                            <TableHead>Account</TableHead>
                            <TableHead className="text-right">Budget</TableHead>
                            <TableHead className="text-right">Actual</TableHead>
                            <TableHead className="text-right">Variance</TableHead>
                            <TableHead className="text-right">%</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {budgetComparison.map((row) => (
                            <TableRow key={row.accountId}>
                              <TableCell className="text-xs font-mono">{row.accountCode}</TableCell>
                              <TableCell className="text-sm">{row.accountName}</TableCell>
                              <TableCell className="text-right text-sm">{formatCurrency(row.budgeted)}</TableCell>
                              <TableCell className="text-right text-sm">{formatCurrency(row.actual)}</TableCell>
                              <TableCell className={`text-right text-sm font-semibold ${row.favourable ? "text-primary" : "text-destructive"}`}>
                                {formatCurrency(row.variance)}
                              </TableCell>
                              <TableCell className={`text-right text-sm ${row.favourable ? "text-primary" : "text-destructive"}`}>
                                {row.variancePercent === null
                                  ? row.unbudgeted ? "Unbudgeted" : "—"
                                  : `${row.variancePercent.toFixed(1)}%`}
                              </TableCell>

                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* ── REPORTS TAB ── */}
          <TabsContent value="reports" className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {reportLinks.map((report) => (
                <Card key={report.label} className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => navigate(report.href)}>
                  <CardContent className="flex flex-col items-center justify-center py-6 gap-2">
                    <report.icon className="h-6 w-6 text-muted-foreground" />
                    <span className="text-sm font-medium text-center">{report.label}</span>
                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* ── CLOSE CHECKLIST TAB ── */}
          <TabsContent value="checklist" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <ClipboardCheck className="h-4 w-4" /> Period Close Checklist
                </CardTitle>
                <CardDescription>
                  Health Score: <span className={`font-semibold ${healthColor}`}>{closeReadiness.healthScore}/100</span>
                  {" • "}{closeReadiness.blockers} blocker(s), {closeReadiness.warnings} warning(s)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {closeReadiness.items.map((item) => {
                  const isClear = item.count === 0;
                  const severityIcon = isClear
                    ? <CheckCircle2 className="h-4 w-4 text-primary" />
                    : item.severity === "blocker"
                      ? <XCircle className="h-4 w-4 text-destructive" />
                      : <AlertTriangle className="h-4 w-4 text-amber-500" />;
                  return (
                    <div key={item.key} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                      <div className="flex items-center gap-2">
                        {severityIcon}
                        <span className="text-sm">{item.label}</span>
                        {!isClear && (
                          <Badge variant="outline" className={`text-[10px] ${item.severity === "blocker" ? "border-destructive text-destructive" : "border-amber-500 text-amber-500"}`}>
                            {item.severity}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${isClear ? "text-primary" : item.severity === "blocker" ? "text-destructive" : "text-amber-500"}`}>
                          {item.count}
                        </span>
                        {item.resolveLink && item.count > 0 && (
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => navigate(item.resolveLink!)}>
                            Resolve <ExternalLink className="h-3 w-3 ml-1" />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}

                <div className="pt-2">
                  {closeReadiness.allClear ? (
                    <Alert className="border-primary/30 bg-primary/5">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      <AlertTitle>Ready to Close</AlertTitle>
                      <AlertDescription>All checks passed. You can safely close this period.</AlertDescription>
                    </Alert>
                  ) : closeReadiness.blockers > 0 ? (
                    <Alert variant="destructive">
                      <XCircle className="h-4 w-4" />
                      <AlertTitle>Blockers Present</AlertTitle>
                      <AlertDescription>Resolve all blocking issues before closing. You can override, but this is not recommended.</AlertDescription>
                    </Alert>
                  ) : (
                    <Alert className="border-amber-500/30 bg-amber-500/5">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      <AlertTitle>Warnings Only</AlertTitle>
                      <AlertDescription>No blockers found, but there are warnings worth reviewing before closing.</AlertDescription>
                    </Alert>
                  )}
                </div>

                {isOpen && canEditPeriods && (
                  <PermissionGate permission="manageFinancials">
                    <Button
                      variant={closeReadiness.blockers > 0 ? "outline" : "destructive"}
                      size="sm"
                      className="w-full mt-2"
                      onClick={handleClose}
                      disabled={actionLoading}
                    >
                      {actionLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Lock className="h-4 w-4 mr-1" />}
                      {closeReadiness.blockers > 0 ? "Close Period (Override)" : "Close Period"}
                    </Button>
                  </PermissionGate>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── NOTES TAB ── */}
          <TabsContent value="notes" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Period Notes</CardTitle>
                  {canEdit && !isEditingNotes && (
                    <Button variant="ghost" size="sm" onClick={startEditNotes}>
                      <Edit3 className="h-4 w-4 mr-1" /> Edit
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {isEditingNotes ? (
                  <div className="space-y-3">
                    <Textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Add notes about this fiscal period..."
                      rows={5}
                    />
                    <div className="flex gap-2 justify-end">
                      <Button variant="outline" size="sm" onClick={() => setIsEditingNotes(false)}>Cancel</Button>
                      <Button size="sm" onClick={handleSaveNotes} disabled={savingNotes}>
                        {savingNotes ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground whitespace-pre-wrap">
                    {period.notes || "No notes for this period."}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Drill-down dialog */}
      <DrillDownDialog
        open={!!drillDown}
        onOpenChange={(open) => !open && setDrillDown(null)}
        config={drillDown}
      />
    </>
  );
}
