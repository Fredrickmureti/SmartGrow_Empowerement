/**
 * Management report — microfinance portfolio KPIs.
 *
 * Every financial figure is server-derived: portfolio balances come from
 * `mf_loan_balances`, arrears/PAR from `mf_par_aging`, collections and
 * disbursements from the append-only event tables. React only aggregates rows
 * the server already computed for display; it never derives outstanding
 * principal, arrears or PAR itself.
 */
import { useMemo, useCallback } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useExpenses } from "@/hooks/useExpenses";
import {
  useMfPortfolioReport,
  useMfCollectionsReport,
  useMfDisbursementsReport,
  useMfParAging,
} from "@/hooks/useMfReports";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Target, TrendingUp, AlertTriangle, CheckCircle } from "lucide-react";
import { startOfMonth, endOfMonth, format } from "date-fns";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";

function ManagementReportsInner() {
  const { currentOrg } = useOrganization();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  const now = new Date();
  const monthStart = format(startOfMonth(now), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(now), "yyyy-MM-dd");

  const { rows: portfolio, isLoading: portfolioLoading } = useMfPortfolioReport();
  const { rows: collections, isLoading: collectionsLoading } = useMfCollectionsReport(
    monthStart,
    monthEnd,
  );
  const { rows: disbursements, isLoading: disbursementsLoading } = useMfDisbursementsReport(
    monthStart,
    monthEnd,
  );
  const { rows: par, isLoading: parLoading } = useMfParAging();
  const { expenses, isLoading: expensesLoading } = useExpenses();

  const isLoading =
    portfolioLoading ||
    collectionsLoading ||
    disbursementsLoading ||
    parLoading ||
    expensesLoading ||
    !currencyReady;

  const kpis = useMemo(() => {
    const activeLoans = portfolio.filter((l) => Number(l.total_outstanding) > 0);
    const portfolioOutstanding = activeLoans.reduce((s, l) => s + l.total_outstanding, 0);
    const principalOutstanding = activeLoans.reduce((s, l) => s + l.principal_outstanding, 0);
    const interestOutstanding = activeLoans.reduce((s, l) => s + l.interest_outstanding, 0);
    const feesOutstanding = activeLoans.reduce((s, l) => s + l.fees_outstanding, 0);
    const amountOverdue = activeLoans.reduce((s, l) => s + l.amount_overdue, 0);
    const loansInArrears = activeLoans.filter((l) => l.amount_overdue > 0).length;

    const parOutstanding = par.reduce((s, r) => s + r.portfolio_outstanding, 0);
    const par1_30 = par.reduce((s, r) => s + r.bucket_1_30, 0);
    const par31_60 = par.reduce((s, r) => s + r.bucket_31_60, 0);
    const par61_90 = par.reduce((s, r) => s + r.bucket_61_90, 0);
    const par90 = par.reduce((s, r) => s + r.bucket_90_plus, 0);
    const parTotal = par1_30 + par31_60 + par61_90 + par90;
    const par30Rate = parOutstanding > 0 ? ((par31_60 + par61_90 + par90) / parOutstanding) * 100 : 0;
    const parRate = parOutstanding > 0 ? (parTotal / parOutstanding) * 100 : 0;

    const collected = collections
      .filter((r) => r.status !== "reversed")
      .reduce((s, r) => s + r.amount, 0);
    const disbursed = disbursements
      .filter((r) => !r.reversed)
      .reduce((s, r) => s + r.net_amount, 0);

    const monthStartDate = startOfMonth(now);
    const monthEndDate = endOfMonth(now);
    const operatingExpenses = expenses
      .filter(
        (e) =>
          (e.status === "approved" || e.status === "paid") &&
          new Date(e.expense_date) >= monthStartDate &&
          new Date(e.expense_date) <= monthEndDate,
      )
      .reduce((s, e) => s + e.amount, 0);

    return {
      activeLoanCount: activeLoans.length,
      clientsServed: new Set(activeLoans.map((l) => l.client_id)).size,
      portfolioOutstanding,
      principalOutstanding,
      interestOutstanding,
      feesOutstanding,
      amountOverdue,
      loansInArrears,
      arrearsRate: portfolioOutstanding > 0 ? (amountOverdue / portfolioOutstanding) * 100 : 0,
      par1_30,
      par31_60,
      par61_90,
      par90,
      parRate,
      par30Rate,
      collected,
      disbursed,
      operatingExpenses,
      avgLoanSize: activeLoans.length > 0 ? portfolioOutstanding / activeLoans.length : 0,
    };
  }, [portfolio, par, collections, disbursements, expenses, now]);

  const getExportConfig = useCallback((): ExportConfig => {
    const rows: ExportRow[] = [];

    rows.push({ metric: "PORTFOLIO", value: null, _isHeader: true });
    rows.push({ metric: "Portfolio Outstanding", value: kpis.portfolioOutstanding, _depth: 1 });
    rows.push({ metric: "Principal Outstanding", value: kpis.principalOutstanding, _depth: 1 });
    rows.push({ metric: "Interest Outstanding", value: kpis.interestOutstanding, _depth: 1 });
    rows.push({ metric: "Fees & Penalties Outstanding", value: kpis.feesOutstanding, _depth: 1 });
    rows.push({ metric: "Active Loans", value: kpis.activeLoanCount, _depth: 1 });
    rows.push({ metric: "Clients With Active Loans", value: kpis.clientsServed, _depth: 1 });
    rows.push({ metric: "Average Outstanding per Loan", value: kpis.avgLoanSize, _depth: 1 });
    rows.push({ metric: "", value: null });

    rows.push({ metric: "PORTFOLIO AT RISK", value: null, _isHeader: true });
    rows.push({ metric: "Amount Overdue", value: kpis.amountOverdue, _depth: 1 });
    rows.push({ metric: "Loans in Arrears", value: kpis.loansInArrears, _depth: 1 });
    rows.push({ metric: "PAR 1-30 days", value: kpis.par1_30, _depth: 1 });
    rows.push({ metric: "PAR 31-60 days", value: kpis.par31_60, _depth: 1 });
    rows.push({ metric: "PAR 61-90 days", value: kpis.par61_90, _depth: 1 });
    rows.push({ metric: "PAR 90+ days", value: kpis.par90, _depth: 1 });
    rows.push({ metric: "", value: null });

    rows.push({ metric: "THIS MONTH", value: null, _isHeader: true });
    rows.push({ metric: "Disbursed (net)", value: kpis.disbursed, _depth: 1 });
    rows.push({ metric: "Collected", value: kpis.collected, _depth: 1 });
    rows.push({ metric: "Operating Expenses", value: kpis.operatingExpenses, _depth: 1 });

    return {
      title: "Management Report",
      subtitle: "Portfolio key performance indicators",
      companyName: currentOrg?.name || "",
      dateRange: `As of ${format(now, "MMM d, yyyy")}`,
      columns: [
        { key: "metric", header: "Metric", width: 50 },
        { key: "value", header: "Value", width: 20, format: "currency", align: "right" },
      ],
      rows,
      sheetName: "Portfolio KPIs",
      currency: baseCurrency,
    };
  }, [kpis, currentOrg, baseCurrency, now]);

  return (
    <CompanyScopeGate reportName="Management Reports">
      <ReportPageLayout
        title="Management Reports"
        description="Portfolio, arrears and collection performance for the institution"
        isLoading={isLoading}
        getExportConfig={getExportConfig}
        headerActions={
          <>
            <RefreshButton
              queryKeyPrefixes={[
                ["mf-report-portfolio"] as const,
                ["mf-par-aging"] as const,
                ["mf-report-collections"] as const,
                ["mf-report-disbursements"] as const,
              ]}
              tooltip="Refresh management reports"
            />
            <SaveViewButton reportType="management" currentFilters={{}} onLoadView={() => {}} />
          </>
        }
      >
        <div className="space-y-6">
          <div className="stats-grid">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Portfolio Outstanding</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatCurrency(kpis.portfolioOutstanding, baseCurrency)}
                </div>
                <p className="text-xs text-muted-foreground">
                  {kpis.activeLoanCount} active loans · {kpis.clientsServed} clients
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">PAR &gt; 30 days</CardTitle>
                <Target
                  className={`h-4 w-4 ${kpis.par30Rate <= 5 ? "text-green-600" : "text-red-600"}`}
                />
              </CardHeader>
              <CardContent>
                <div
                  className={`text-2xl font-bold ${kpis.par30Rate <= 5 ? "text-green-600" : "text-red-600"}`}
                >
                  {kpis.par30Rate.toFixed(1)}%
                </div>
                <Progress value={Math.min(kpis.par30Rate, 100)} className="mt-2" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Collected This Month</CardTitle>
                <CheckCircle className="h-4 w-4 text-green-600" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-600">
                  {formatCurrency(kpis.collected, baseCurrency)}
                </div>
                <p className="text-xs text-muted-foreground">
                  Disbursed {formatCurrency(kpis.disbursed, baseCurrency)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Arrears Rate</CardTitle>
                <AlertTriangle
                  className={`h-4 w-4 ${kpis.arrearsRate <= 5 ? "text-green-600" : "text-orange-600"}`}
                />
              </CardHeader>
              <CardContent>
                <div
                  className={`text-2xl font-bold ${kpis.arrearsRate <= 5 ? "text-green-600" : "text-orange-600"}`}
                >
                  {kpis.arrearsRate.toFixed(1)}%
                </div>
                <p className="text-xs text-muted-foreground">
                  {kpis.loansInArrears} loans in arrears
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Portfolio composition</CardTitle>
                <CardDescription>Outstanding balances by component</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Principal</span>
                  <span className="text-lg font-bold">
                    {formatCurrency(kpis.principalOutstanding, baseCurrency)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Interest</span>
                  <span className="text-lg font-bold">
                    {formatCurrency(kpis.interestOutstanding, baseCurrency)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Fees &amp; penalties</span>
                  <span className="text-lg font-bold">
                    {formatCurrency(kpis.feesOutstanding, baseCurrency)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t pt-4">
                  <span className="text-sm">Average outstanding per loan</span>
                  <span className="font-medium">
                    {formatCurrency(kpis.avgLoanSize, baseCurrency)}
                  </span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Portfolio at risk</CardTitle>
                <CardDescription>Outstanding balance by days past due</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">1 – 30 days</span>
                  <span className="text-lg font-bold">
                    {formatCurrency(kpis.par1_30, baseCurrency)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">31 – 60 days</span>
                  <span className="text-lg font-bold">
                    {formatCurrency(kpis.par31_60, baseCurrency)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">61 – 90 days</span>
                  <span className="text-lg font-bold">
                    {formatCurrency(kpis.par61_90, baseCurrency)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-red-600">Over 90 days</span>
                  <span className="text-lg font-bold text-red-600">
                    {formatCurrency(kpis.par90, baseCurrency)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t pt-4">
                  <span className="text-sm">PAR (all buckets)</span>
                  <span
                    className={`font-medium ${kpis.parRate > 10 ? "text-red-600" : "text-green-600"}`}
                  >
                    {kpis.parRate.toFixed(1)}%
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>This month</CardTitle>
              <CardDescription>Lending activity and operating cost</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="rounded-lg border p-4 text-center">
                  <div className="text-3xl font-bold text-primary">
                    {formatCurrency(kpis.disbursed, baseCurrency)}
                  </div>
                  <p className="text-sm text-muted-foreground">Disbursed (net of fees)</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <div className="text-3xl font-bold text-green-600">
                    {formatCurrency(kpis.collected, baseCurrency)}
                  </div>
                  <p className="text-sm text-muted-foreground">Collected</p>
                </div>
                <div className="rounded-lg border p-4 text-center">
                  <div className="text-3xl font-bold text-blue-600">
                    {formatCurrency(kpis.operatingExpenses, baseCurrency)}
                  </div>
                  <p className="text-sm text-muted-foreground">Operating expenses</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
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
