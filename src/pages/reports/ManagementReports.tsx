import { useMemo, useCallback, useState } from "react";
import { DrillDownDialog, DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { useOrganization } from "@/hooks/useOrganization";
import { useInvoices } from "@/hooks/useInvoices";
import { useExpenses } from "@/hooks/useExpenses";
import { useBills } from "@/hooks/useBills";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Target, TrendingUp, AlertTriangle, CheckCircle } from "lucide-react";
import { startOfMonth, endOfMonth, subMonths, differenceInDays, format } from "date-fns";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";

function ManagementReportsInner() {
  const [drillDown, setDrillDown] = useState<{ open: boolean; config: DrillDownConfig | null }>({ open: false, config: null });
  const { currentOrg } = useOrganization();
  const { invoices, isLoading: invoicesLoading } = useInvoices();
  const { expenses, isLoading: expensesLoading } = useExpenses();
  const { bills, isLoading: billsLoading } = useBills();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  const isLoading = invoicesLoading || expensesLoading || billsLoading || !currencyReady;

  const now = new Date();
  const thisMonthStart = startOfMonth(now);
  const thisMonthEnd = endOfMonth(now);
  const lastMonthStart = startOfMonth(subMonths(now, 1));
  const lastMonthEnd = endOfMonth(subMonths(now, 1));

  const VALID_INVOICE_STATUSES = ["sent", "viewed", "partial", "paid", "overdue"];

  const kpis = useMemo(() => {
    const validInvoices = invoices.filter((i) => VALID_INVOICE_STATUSES.includes(i.status));

    const thisMonthRevenue = validInvoices
      .filter((i) => i.status === "paid" && new Date(i.issue_date) >= thisMonthStart && new Date(i.issue_date) <= thisMonthEnd)
      .reduce((sum, i) => sum + i.total, 0);

    const lastMonthRevenue = validInvoices
      .filter((i) => i.status === "paid" && new Date(i.issue_date) >= lastMonthStart && new Date(i.issue_date) <= lastMonthEnd)
      .reduce((sum, i) => sum + i.total, 0);

    const totalReceivables = validInvoices
      .filter((i) => ["sent", "viewed", "partial", "overdue"].includes(i.status))
      .reduce((sum, i) => sum + (i.total - i.amount_paid), 0);

    const overdueReceivables = validInvoices
      .filter((i) => i.status === "overdue")
      .reduce((sum, i) => sum + (i.total - i.amount_paid), 0);

    const paidInvoices = validInvoices.filter((i) => i.status === "paid");
    const avgDSO = paidInvoices.length > 0
      ? paidInvoices.reduce((sum, i) => {
          const dso = differenceInDays(new Date(i.updated_at), new Date(i.issue_date));
          return sum + dso;
        }, 0) / paidInvoices.length
      : 0;

    const totalPayables = bills
      .filter((b) => ["received", "partial"].includes(b.status))
      .reduce((sum, b) => sum + (b.total - (b.amount_paid || 0)), 0);

    const overduePayables = bills
      .filter((b) => new Date(b.due_date) < now && ["received", "partial"].includes(b.status))
      .reduce((sum, b) => sum + (b.total - (b.amount_paid || 0)), 0);

    const thisMonthExpenses = expenses
      .filter((e) => (e.status === "approved" || e.status === "paid") && new Date(e.expense_date) >= thisMonthStart && new Date(e.expense_date) <= thisMonthEnd)
      .reduce((sum, e) => sum + e.amount, 0);

    const profitMargin = thisMonthRevenue > 0 
      ? ((thisMonthRevenue - thisMonthExpenses) / thisMonthRevenue * 100)
      : 0;

    const totalInvoiced = validInvoices.reduce((sum, i) => sum + i.total, 0);
    const totalCollected = validInvoices.reduce((sum, i) => sum + i.amount_paid, 0);
    const collectionRate = totalInvoiced > 0 ? (totalCollected / totalInvoiced * 100) : 0;

    return {
      thisMonthRevenue,
      lastMonthRevenue,
      revenueGrowth: lastMonthRevenue > 0 ? ((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue * 100) : 0,
      totalReceivables,
      overdueReceivables,
      avgDSO: Math.round(avgDSO),
      totalPayables,
      overduePayables,
      thisMonthExpenses,
      profitMargin,
      collectionRate,
      invoiceCount: validInvoices.length,
      paidInvoiceCount: paidInvoices.length,
    };
  }, [invoices, expenses, bills, thisMonthStart, thisMonthEnd, lastMonthStart, lastMonthEnd, now]);

  const getExportConfig = useCallback((): ExportConfig => {
    const rows: ExportRow[] = [];

    rows.push({ metric: "REVENUE & PROFITABILITY", value: null, _isHeader: true });
    rows.push({ metric: "This Month Revenue", value: kpis.thisMonthRevenue, _depth: 1 });
    rows.push({ metric: "Last Month Revenue", value: kpis.lastMonthRevenue, _depth: 1 });
    rows.push({ metric: `Revenue Growth`, value: null, _depth: 1 });
    rows.push({ metric: "This Month Expenses", value: kpis.thisMonthExpenses, _depth: 1 });
    rows.push({ metric: "Profit Margin", value: null, _depth: 1 });
    rows.push({ metric: "", value: null });

    rows.push({ metric: "ACCOUNTS RECEIVABLE", value: null, _isHeader: true });
    rows.push({ metric: "Total Outstanding", value: kpis.totalReceivables, _depth: 1 });
    rows.push({ metric: "Overdue", value: kpis.overdueReceivables, _depth: 1 });
    rows.push({ metric: `Days Sales Outstanding`, value: null, _depth: 1 });
    rows.push({ metric: "Collection Rate", value: null, _depth: 1 });
    rows.push({ metric: "", value: null });

    rows.push({ metric: "ACCOUNTS PAYABLE", value: null, _isHeader: true });
    rows.push({ metric: "Total Outstanding", value: kpis.totalPayables, _depth: 1 });
    rows.push({ metric: "Overdue", value: kpis.overduePayables, _depth: 1 });
    rows.push({ metric: "", value: null });

    rows.push({ metric: "INVOICE STATISTICS", value: null, _isHeader: true });
    rows.push({ metric: "Total Invoices", value: kpis.invoiceCount, _depth: 1 });
    rows.push({ metric: "Paid Invoices", value: kpis.paidInvoiceCount, _depth: 1 });

    return {
      title: "Management Report",
      subtitle: "Key Performance Indicators",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `As of ${format(now, "MMM d, yyyy")}`,
      columns: [
        { key: "metric", header: "Metric", width: 50 },
        { key: "value", header: "Value", width: 20, format: "currency", align: "right" },
      ],
      rows,
      sheetName: "Management KPIs",
      currency: baseCurrency,
    };
  }, [kpis, currentOrg, baseCurrency, now]);

  return (
    <CompanyScopeGate reportName="Management Reports">
    <ReportPageLayout
      title="Management Reports"
      description="Key performance indicators and business health metrics"
      isLoading={isLoading}
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['invoices'] as const, ['expenses'] as const]} tooltip="Refresh management reports" />
          <SaveViewButton reportType="management" currentFilters={{}} onLoadView={() => {}} />
        </>
      }
    >
      <div className="space-y-6">
        <div className="stats-grid">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Revenue Growth</CardTitle>
              <TrendingUp className={`h-4 w-4 ${kpis.revenueGrowth >= 0 ? "text-green-600" : "text-red-600"}`} />
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${kpis.revenueGrowth >= 0 ? "text-green-600" : "text-red-600"}`}>
                {kpis.revenueGrowth >= 0 ? "+" : ""}{kpis.revenueGrowth.toFixed(1)}%
              </div>
              <p className="text-xs text-muted-foreground">vs last month</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Profit Margin</CardTitle>
              <Target className={`h-4 w-4 ${kpis.profitMargin >= 20 ? "text-green-600" : "text-orange-600"}`} />
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${kpis.profitMargin >= 20 ? "text-green-600" : "text-orange-600"}`}>
                {kpis.profitMargin.toFixed(1)}%
              </div>
              <Progress value={Math.min(kpis.profitMargin, 100)} className="mt-2" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Collection Rate</CardTitle>
              <CheckCircle className={`h-4 w-4 ${kpis.collectionRate >= 80 ? "text-green-600" : "text-orange-600"}`} />
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${kpis.collectionRate >= 80 ? "text-green-600" : "text-orange-600"}`}>
                {kpis.collectionRate.toFixed(1)}%
              </div>
              <Progress value={kpis.collectionRate} className="mt-2" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg DSO</CardTitle>
              <AlertTriangle className={`h-4 w-4 ${kpis.avgDSO <= 30 ? "text-green-600" : "text-orange-600"}`} />
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${kpis.avgDSO <= 30 ? "text-green-600" : "text-orange-600"}`}>
                {kpis.avgDSO} days
              </div>
              <p className="text-xs text-muted-foreground">Days Sales Outstanding</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Accounts Receivable</CardTitle>
              <CardDescription>Outstanding customer balances</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Total Outstanding</span>
                <span className="text-lg font-bold">
                  <button className="hover:underline hover:text-primary cursor-pointer" onClick={() => setDrillDown({ open: true, config: { title: "Outstanding Receivables", startDate: format(thisMonthStart, "yyyy-MM-dd"), endDate: format(thisMonthEnd, "yyyy-MM-dd"), sourceType: "invoice" } })}>
                    {formatCurrency(kpis.totalReceivables, baseCurrency)}
                  </button>
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-red-600">Overdue</span>
                <span className="text-lg font-bold text-red-600">{formatCurrency(kpis.overdueReceivables, baseCurrency)}</span>
              </div>
              <div className="flex justify-between items-center pt-4 border-t">
                <span className="text-sm">Overdue %</span>
                <span className={`font-medium ${kpis.totalReceivables > 0 && (kpis.overdueReceivables / kpis.totalReceivables * 100) > 20 ? "text-red-600" : "text-green-600"}`}>
                  {kpis.totalReceivables > 0 ? (kpis.overdueReceivables / kpis.totalReceivables * 100).toFixed(1) : 0}%
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Accounts Payable</CardTitle>
              <CardDescription>Outstanding vendor balances</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Total Outstanding</span>
                <span className="text-lg font-bold">{formatCurrency(kpis.totalPayables, baseCurrency)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium text-red-600">Overdue</span>
                <span className="text-lg font-bold text-red-600">{formatCurrency(kpis.overduePayables, baseCurrency)}</span>
              </div>
              <div className="flex justify-between items-center pt-4 border-t">
                <span className="text-sm">Overdue %</span>
                <span className={`font-medium ${kpis.totalPayables > 0 && (kpis.overduePayables / kpis.totalPayables * 100) > 20 ? "text-red-600" : "text-green-600"}`}>
                  {kpis.totalPayables > 0 ? (kpis.overduePayables / kpis.totalPayables * 100).toFixed(1) : 0}%
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Key Business Metrics</CardTitle>
            <CardDescription>Summary of business performance indicators</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="text-center p-4 border rounded-lg">
                <div className="text-3xl font-bold text-primary">{kpis.invoiceCount}</div>
                <p className="text-sm text-muted-foreground">Total Invoices</p>
              </div>
              <div className="text-center p-4 border rounded-lg">
                <div className="text-3xl font-bold text-green-600">{kpis.paidInvoiceCount}</div>
                <p className="text-sm text-muted-foreground">Paid Invoices</p>
              </div>
              <div className="text-center p-4 border rounded-lg">
                <div className="text-3xl font-bold text-blue-600">{formatCurrency(kpis.thisMonthRevenue, baseCurrency)}</div>
                <p className="text-sm text-muted-foreground">This Month Revenue</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      <DrillDownDialog
        open={drillDown.open}
        onOpenChange={(open) => setDrillDown((prev) => ({ ...prev, open }))}
        config={drillDown.config}
      />
    </ReportPageLayout>
    </CompanyScopeGate>
  );
}

export default function ManagementReports() {
  return (
    <ReportFilterProvider>
      <ManagementReportsInner />
    </ReportFilterProvider>
  );
}

