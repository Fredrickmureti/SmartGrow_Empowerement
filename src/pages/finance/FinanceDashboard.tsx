import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FileText, Receipt, Landmark, ArrowRight, AlertCircle, Clock, CheckCircle,
  CreditCard, Wallet, TrendingUp, TrendingDown, BarChart3, Plus,
  PiggyBank, ArrowRightLeft,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { useDashboardComposition } from "@/hooks/useDashboardComposition";
import { DashboardSetupGuide } from "@/components/dashboard/DashboardSetupGuide";
import { fetchGLTotals, type GLTotals } from "@/services/gl/fetchGLTotals";
import {
  fetchARSummary,
  fetchAPSummary,
  EMPTY_OPEN_ITEMS_SUMMARY,
} from "@/services/finance/openItems";
import { arSummaryKey, apSummaryKey } from "@/hooks/finance/useOpenItemsSummary";
import { queryKeys } from "@/lib/queryKeys";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { startOfMonth, endOfMonth, startOfQuarter, endOfQuarter, startOfYear, endOfYear, format } from "date-fns";

type PeriodFilter = "month" | "quarter" | "year" | "all";

interface StatusCount {
  status: string;
  count: number;
}

export default function FinanceDashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<PeriodFilter>("month");
  const { accounts: bankAccountsList, isLoading: bankLoading } = useBankAccounts();
  const { formatCurrency } = useCurrency();

  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { branchId, scopeLabel, hasMultipleBranches, isConsolidated } = useFinanceScope();
  const composition = useDashboardComposition();
  // Only show finance-relevant gaps on this surface (skip sales/inventory/hr).
  const financeGaps = composition.setupGaps.filter((g) =>
    g === "bank" || g === "coa"
  );

  // Period date range
  const now = new Date();
  const { dateFrom, dateTo } = useMemo(() => {
    const getRange = (p: PeriodFilter) => {
      switch (p) {
        case "month": return { s: startOfMonth(now), e: endOfMonth(now) };
        case "quarter": return { s: startOfQuarter(now), e: endOfQuarter(now) };
        case "year": return { s: startOfYear(now), e: endOfYear(now) };
        default: return { s: new Date(1900, 0, 1), e: now };
      }
    };
    const cur = getRange(period);
    return { dateFrom: format(cur.s, "yyyy-MM-dd"), dateTo: format(cur.e, "yyyy-MM-dd") };
  }, [period]);

  const orgId = currentOrg?.id || "";
  const businessId = currentBusiness?.id || null;

  // GL-based revenue/expenses via useQuery (single source of truth, branch-scoped)
  const { data: glData = { revenue: 0, expenses: 0, netProfit: 0 }, isLoading: glLoading } = useQuery({
    queryKey: [...queryKeys.glTotals.range(orgId, businessId, dateFrom, dateTo), branchId] as const,
    queryFn: () => fetchGLTotals(orgId, dateFrom, dateTo, businessId, branchId),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  // Invoice status counts via lightweight RPC (branch-scoped)
  const { data: invoiceCounts = [], isLoading: invLoading } = useQuery({
    queryKey: ["invoice-status-counts", orgId, businessId, branchId] as const,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_invoice_status_counts", {
        _org_id: orgId,
        _business_id: businessId,
        _branch_id: branchId,
      } as any);
      if (error) throw error;
      return (data || []) as StatusCount[];
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });

  // Bill status counts via lightweight RPC (branch-scoped)
  const { data: billCounts = [], isLoading: billsLoading } = useQuery({
    queryKey: ["bill-status-counts", orgId, businessId, branchId] as const,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_bill_status_counts", {
        _org_id: orgId,
        _business_id: businessId,
        _branch_id: branchId,
      } as any);
      if (error) throw error;
      return (data || []) as StatusCount[];
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });

  // JE status counts — branch-scoped lightweight head-only count queries
  const { data: jeCounts = { draft: 0, posted: 0, total: 0 }, isLoading: jeLoading } = useQuery({
    queryKey: ["je-status-counts", orgId, businessId, branchId] as const,
    queryFn: async () => {
      const buildQuery = (status?: string) => {
        let q = supabase
          .from("journal_entries")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId);
        if (businessId) q = q.eq("business_id", businessId);
        if (branchId) q = q.eq("branch_id", branchId);
        if (status) q = q.eq("status", status);
        return q;
      };

      const [draftRes, postedRes, totalRes] = await Promise.all([
        buildQuery("draft"),
        buildQuery("posted"),
        buildQuery(),
      ]);

      if (draftRes.error) throw draftRes.error;
      if (postedRes.error) throw postedRes.error;
      if (totalRes.error) throw totalRes.error;

      return {
        draft: draftRes.count || 0,
        posted: postedRes.count || 0,
        total: totalRes.count || 0,
      };
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });

  // Canonical AR/AP — GL-gated open items (same engine as the AR/AP
  // workspaces, ageing report and control-account reconciliation).
  const { data: arSummary = EMPTY_OPEN_ITEMS_SUMMARY, isLoading: arLoading } = useQuery({
    queryKey: arSummaryKey(orgId, businessId, branchId),
    queryFn: () => fetchARSummary(orgId, businessId, branchId),
    enabled: !!orgId,
    staleTime: 30_000,
  });
  const { data: apSummary = EMPTY_OPEN_ITEMS_SUMMARY, isLoading: apLoading } = useQuery({
    queryKey: apSummaryKey(orgId, businessId, branchId),
    queryFn: () => fetchAPSummary(orgId, businessId, branchId),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  const isLoading = invLoading || billsLoading || bankLoading || jeLoading || glLoading || arLoading || apLoading;


  // Query keys for RefreshButton (branch-scoped)
  const refreshKeys = useMemo(() => [
    [...queryKeys.glTotals.range(orgId, businessId, dateFrom, dateTo), branchId] as const,
    ["invoice-status-counts", orgId, businessId, branchId] as const,
    ["bill-status-counts", orgId, businessId, branchId] as const,
    ["je-status-counts", orgId, businessId, branchId] as const,
    ['bank-accounts', orgId] as const,
    arSummaryKey(orgId, businessId, branchId),
    apSummaryKey(orgId, businessId, branchId),
  ], [orgId, businessId, branchId, dateFrom, dateTo]);

  const periodRevenue = glData.revenue;
  const periodExpenses = glData.expenses;
  const netPL = glData.netProfit;

  // Helper to get count from status counts array
  const getCount = (counts: StatusCount[], ...statuses: string[]) =>
    counts.filter(c => statuses.includes(c.status)).reduce((s, c) => s + c.count, 0);

  // Document-pipeline counts (operational, NOT accounting).
  const draftInvoiceCount = getCount(invoiceCounts, "draft");
  const overdueInvoiceCount = getCount(invoiceCounts, "overdue");
  const draftBillCount = getCount(billCounts, "draft");
  const overdueBillCount = getCount(billCounts, "overdue");


  // Bank stats
  const totalBankBalance = bankAccountsList.reduce(
    (s, a) => s + (resolveBankAccountBalance(a)?.amount ?? 0),
    0,
  );
  const activeAccounts = bankAccountsList.filter(a => a.is_active);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-48 mb-2" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}><CardContent className="p-6"><Skeleton className="h-20 w-full" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">Finance Overview</h1>
          <p className="text-sm text-muted-foreground mt-1">
            At-a-glance view of your accounting journals and balances
          </p>
          <div className="mt-2"><FinanceScopeBadge /></div>
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton queryKeyPrefixes={refreshKeys} tooltip="Refresh finance data" />
          <Select value={period} onValueChange={(v) => setPeriod(v as PeriodFilter)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="month">This Month</SelectItem>
              <SelectItem value="quarter">This Quarter</SelectItem>
              <SelectItem value="year">This Year</SelectItem>
              <SelectItem value="all">All Time</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {financeGaps.length > 0 && <DashboardSetupGuide gaps={financeGaps} />}

      {/* KPI Summary Row — click to drill into P&L report.
          Gated by role (cashier/sales don't see P&L). */}
      {composition.allowsWidget("finance.kpis") && (
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => navigate("/finance/reports/financial")}>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <TrendingUp className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Revenue</p>
              <p className="text-lg font-bold">{formatCurrency(periodRevenue)}</p>
              <p className="text-[10px] text-muted-foreground">Source: General Ledger</p>
            </div>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => navigate("/finance/reports/financial")}>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-destructive/10">
              <TrendingDown className="h-5 w-5 text-destructive" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Expenses</p>
              <p className="text-lg font-bold">{formatCurrency(periodExpenses)}</p>
              <p className="text-[10px] text-muted-foreground">Source: General Ledger</p>
            </div>
          </CardContent>
        </Card>
        <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => navigate("/finance/reports/financial")}>
          <CardContent className="p-4 flex items-center gap-3">
            <div className={`p-2 rounded-lg ${netPL >= 0 ? "bg-primary/10" : "bg-destructive/10"}`}>
              <BarChart3 className={`h-5 w-5 ${netPL >= 0 ? "text-primary" : "text-destructive"}`} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Net Profit/Loss</p>
              <p className={`text-lg font-bold ${netPL >= 0 ? "text-primary" : "text-destructive"}`}>
                {formatCurrency(netPL)}
              </p>
              <p className="text-[10px] text-muted-foreground">Source: General Ledger</p>
            </div>
          </CardContent>
        </Card>
      </div>
      )}

      {/* Odoo-style Journal Cards — gated so the bank card can still
          render for operations while AR/AP/JE journals stay
          accountant/executive-only. */}
      {(composition.allowsWidget("finance.journals") || composition.allowsWidget("finance.bankBalances")) && (
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {composition.allowsWidget("finance.journals") && (<>
        {/* Customer Invoices Card */}
        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-blue-500" onClick={() => navigate("/finance/receivables")}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Customer Invoices</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-2xl font-bold text-primary">{formatCurrency(arSummary.totalResidual)}</div>
            <p className="text-xs text-muted-foreground">
              {arSummary.openDocumentCount} open · Source: General Ledger
            </p>
            <div className="flex flex-wrap gap-1.5">
              {draftInvoiceCount > 0 && (
                <Badge variant="outline" className="text-xs">
                  <Clock className="h-3 w-3 mr-1" />{draftInvoiceCount} draft
                </Badge>
              )}
              {overdueInvoiceCount > 0 && (
                <Badge variant="destructive" className="text-xs">
                  <AlertCircle className="h-3 w-3 mr-1" />{overdueInvoiceCount} overdue
                </Badge>
              )}
              {arSummary.unpostedDocumentCount > 0 && (
                <Badge variant="destructive" className="text-xs">
                  <AlertCircle className="h-3 w-3 mr-1" />{arSummary.unpostedDocumentCount} unposted
                </Badge>
              )}
            </div>

          </CardContent>
        </Card>

        {/* Vendor Bills Card */}
        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-orange-500" onClick={() => navigate("/finance/payables")}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Vendor Bills</CardTitle>
              <Receipt className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-2xl font-bold text-primary">{formatCurrency(apSummary.totalResidual)}</div>
            <p className="text-xs text-muted-foreground">
              {apSummary.openDocumentCount} open · Source: General Ledger
            </p>

            <div className="flex flex-wrap gap-1.5">
              {draftBillCount > 0 && (
                <Badge variant="outline" className="text-xs">
                  <Clock className="h-3 w-3 mr-1" />{draftBillCount} draft
                </Badge>
              )}
              {overdueBillCount > 0 && (
                <Badge variant="destructive" className="text-xs">
                  <AlertCircle className="h-3 w-3 mr-1" />{overdueBillCount} overdue
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
        </>)}

        {composition.allowsWidget("finance.bankBalances") && (
        /* Bank Card — visible to operations too. */
        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-emerald-500" onClick={() => navigate("/finance/banking")}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Bank</CardTitle>
              <Landmark className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-2xl font-bold text-primary">{formatCurrency(totalBankBalance)}</div>
            <p className="text-xs text-muted-foreground">Total balance</p>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary" className="text-xs">
                {activeAccounts.length} active account{activeAccounts.length !== 1 ? "s" : ""}
              </Badge>
            </div>
          </CardContent>
        </Card>
        )}

        {composition.allowsWidget("finance.journals") && (
        /* Journal Entries Card */
        <Card className="cursor-pointer hover:shadow-md transition-shadow border-l-4 border-l-purple-500" onClick={() => navigate("/finance/journal-entries")}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Journal Entries</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-2xl font-bold text-primary">{jeCounts.total}</div>
            <p className="text-xs text-muted-foreground">Total entries</p>
            <div className="flex flex-wrap gap-1.5">
              {jeCounts.draft > 0 && (
                <Badge variant="outline" className="text-xs">
                  <Clock className="h-3 w-3 mr-1" />{jeCounts.draft} draft
                </Badge>
              )}
              <Badge variant="secondary" className="text-xs">
                <CheckCircle className="h-3 w-3 mr-1" />{jeCounts.posted} posted
              </Badge>
            </div>
          </CardContent>
        </Card>
        )}
      </div>
      )}

      {/* Quick Actions — direct actions, no double navigation */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Actions</CardTitle>
          <CardDescription>Common accounting tasks</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/finance/receivables")}>
              <Wallet className="h-3 w-3 mr-1" /> Receive Payment <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/finance/payables")}>
              <CreditCard className="h-3 w-3 mr-1" /> Pay Bill <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/finance/business-transactions/new?type=owner_investment")}>
              <PiggyBank className="h-3 w-3 mr-1" /> Owner Investment
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/finance/business-transactions/new?type=bank_transfer")}>
              <ArrowRightLeft className="h-3 w-3 mr-1" /> Transfer Funds
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/finance/business-transactions/new?type=loan_payment")}>
              <Landmark className="h-3 w-3 mr-1" /> Loan Payment
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/finance/journal-entries?action=create")}>
              <Plus className="h-3 w-3 mr-1" /> New Journal Entry
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/finance/reconciliation")}>
              Reconciliation <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/finance/reports")}>
              Financial Reports <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
