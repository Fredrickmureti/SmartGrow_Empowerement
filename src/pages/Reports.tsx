import { useState, useMemo, useCallback } from "react";
import { ReportsLayout } from "@/apps/reports/ReportsLayout";
import { useInvoices } from "@/hooks/useInvoices";
import { useExpenses } from "@/hooks/useExpenses";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useFinancialReport } from "@/hooks/useFinancialReport";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TrendingUp,
  TrendingDown,
  Coins,
  FileText,
  Loader2,
} from "lucide-react";
import { format, subMonths, startOfMonth, endOfMonth, isWithinInterval } from "date-fns";
import { ReportCharts, ChartType } from "@/components/reports/ReportCharts";

export default function Reports() {
  const { invoices, isLoading: invoicesLoading } = useInvoices();
  const { expenses, isLoading: expensesLoading } = useExpenses();
  const { accounts, getAccountsByType, isLoading: accountsLoading } = useAccounts();
  const { formatCurrency, baseCurrency, getCurrencySymbol, isReady: currencyReady } = useCurrency();
  const { currentOrg } = useOrganization();
  
  const [dateRange, setDateRange] = useState("this_month");
  const [expenseChartType, setExpenseChartType] = useState<ChartType>("pie");
  const [revenueChartType, setRevenueChartType] = useState<ChartType>("bar");
  const [agingChartType, setAgingChartType] = useState<ChartType>("bar");

  // Journal-entry-based P&L from the financial report engine
  const { start: dateStart, end: dateEnd } = useMemo(() => {
    const now = new Date();
    switch (dateRange) {
      case "this_month":
        return { start: startOfMonth(now), end: endOfMonth(now) };
      case "last_month":
        return { start: startOfMonth(subMonths(now, 1)), end: endOfMonth(subMonths(now, 1)) };
      case "last_3_months":
        return { start: startOfMonth(subMonths(now, 2)), end: endOfMonth(now) };
      case "last_6_months":
        return { start: startOfMonth(subMonths(now, 5)), end: endOfMonth(now) };
      case "this_year":
        return { start: new Date(now.getFullYear(), 0, 1), end: new Date(now.getFullYear(), 11, 31) };
      default:
        return { start: startOfMonth(now), end: endOfMonth(now) };
    }
  }, [dateRange]);

  const { data: pnlReport, isLoading: pnlReportLoading } = useFinancialReport({
    reportType: "pnl",
    dateFrom: format(dateStart, "yyyy-MM-dd"),
    dateTo: format(dateEnd, "yyyy-MM-dd"),
  });

  // GL-sourced Balance Sheet (single source of truth)
  const { data: bsReport, isLoading: bsReportLoading } = useFinancialReport({
    reportType: "balance_sheet",
    dateFrom: "1970-01-01",
    dateTo: format(dateEnd, "yyyy-MM-dd"),
  });

  const isLoading = invoicesLoading || expensesLoading || accountsLoading || pnlReportLoading || bsReportLoading;
  const currencySymbol = getCurrencySymbol(baseCurrency);

  const start = dateStart;
  const end = dateEnd;

  const filteredInvoices = useMemo(
    () =>
      invoices.filter((inv) => {
        const date = new Date(inv.issue_date);
        return isWithinInterval(date, { start, end });
      }),
    [invoices, start, end]
  );

  const filteredExpenses = useMemo(
    () =>
      expenses.filter((exp) => {
        const date = new Date(exp.expense_date);
        return isWithinInterval(date, { start, end });
      }),
    [expenses, start, end]
  );

  // Profit & Loss calculations — from journal entries (accrual-based)
  const pnl = useMemo(() => {
    if (pnlReport) {
      const revenue = pnlReport.sectionTotals["income"] || 0;
      const totalExpenses = pnlReport.sectionTotals["expense"] || 0;
      const grossProfit = revenue - totalExpenses;
      return { revenue, expenses: totalExpenses, grossProfit };
    }
    // Fallback while loading
    return { revenue: 0, expenses: 0, grossProfit: 0 };
  }, [pnlReport]);

  // Balance Sheet from GL (includes retained earnings)
  const balanceSheet = useMemo(() => {
    if (bsReport?.balanceSheetTotals) {
      return {
        assetAccounts: bsReport.sections["asset"] || [],
        liabilityAccounts: bsReport.sections["liability"] || [],
        equityAccounts: bsReport.sections["equity"] || [],
        totalAssets: bsReport.balanceSheetTotals.totalAssets,
        totalLiabilities: bsReport.balanceSheetTotals.totalLiabilities,
        totalEquity: bsReport.balanceSheetTotals.totalEquity,
        retainedEarnings: bsReport.balanceSheetTotals.retainedEarnings,
      };
    }
    return {
      assetAccounts: [],
      liabilityAccounts: [],
      equityAccounts: [],
      totalAssets: 0,
      totalLiabilities: 0,
      totalEquity: 0,
      retainedEarnings: 0,
    };
  }, [bsReport]);

  // Expense breakdown from GL (journal entries), not from expenses table
  const expensesByCategory = useMemo(() => {
    if (pnlReport?.sections["expense"]) {
      return pnlReport.sections["expense"]
        .filter(a => !a.is_group)
        .map(a => ({ name: a.name, amount: a.display_amount }))
        .filter(a => a.amount !== 0)
        .sort((a, b) => b.amount - a.amount);
    }
    return [];
  }, [pnlReport]);

  // Invoice aging
  const invoiceAging = useMemo(() => {
    const now = new Date();
    const aging = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 };

    invoices
      .filter((i) => ["sent", "viewed", "partial", "overdue"].includes(i.status))
      .forEach((inv) => {
        const dueDate = new Date(inv.due_date);
        const daysOverdue = Math.floor(
          (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        const balance = inv.total - inv.amount_paid;

        if (daysOverdue <= 0) aging.current += balance;
        else if (daysOverdue <= 30) aging.days30 += balance;
        else if (daysOverdue <= 60) aging.days60 += balance;
        else if (daysOverdue <= 90) aging.days90 += balance;
        else aging.over90 += balance;
      });

    return aging;
  }, [invoices]);

  // Monthly revenue data for charts
  const monthlyData = useMemo(() => {
    const months: Record<string, { revenue: number; expenses: number }> = {};
    
    filteredInvoices
      .filter((i) => i.status === "paid")
      .forEach((inv) => {
        const month = format(new Date(inv.issue_date), "MMM");
        if (!months[month]) months[month] = { revenue: 0, expenses: 0 };
        months[month].revenue += inv.total;
      });
    
    filteredExpenses
      .filter((e) => e.status === "approved" || e.status === "paid")
      .forEach((exp) => {
        const month = format(new Date(exp.expense_date), "MMM");
        if (!months[month]) months[month] = { revenue: 0, expenses: 0 };
        months[month].expenses += exp.amount;
      });
    
    return Object.entries(months).map(([name, data]) => ({
      name,
      value: data.revenue,
      expenses: data.expenses,
    }));
  }, [filteredInvoices, filteredExpenses]);

  const dateRangeLabel = {
    this_month: format(start, "MMMM yyyy"),
    last_month: format(start, "MMMM yyyy"),
    last_3_months: `${format(start, "MMM yyyy")} - ${format(end, "MMM yyyy")}`,
    last_6_months: `${format(start, "MMM yyyy")} - ${format(end, "MMM yyyy")}`,
    this_year: format(start, "yyyy"),
  }[dateRange];

  // Chart data transformations
  const expenseChartData = expensesByCategory.map((cat) => ({
    name: cat.name,
    value: cat.amount,
  }));

  const agingChartData = [
    { name: "Current", value: invoiceAging.current },
    { name: "1-30 Days", value: invoiceAging.days30 },
    { name: "31-60 Days", value: invoiceAging.days60 },
    { name: "61-90 Days", value: invoiceAging.days90 },
    { name: "90+ Days", value: invoiceAging.over90 },
  ].filter((item) => item.value > 0);

  const getExportConfig = useCallback((): ExportConfig => {
    const rows: ExportRow[] = [];
    // P&L rows
    rows.push({ item: "Revenue", amount: null, _isHeader: true });
    if (pnlReport?.sections["income"]) {
      for (const acct of pnlReport.sections["income"]) {
        rows.push({ item: `  ${acct.name}`, amount: acct.display_amount });
      }
    }
    rows.push({ item: "Total Revenue", amount: pnl.revenue, _isSubtotal: true });
    rows.push({ item: "Expenses", amount: null, _isHeader: true });
    for (const cat of expensesByCategory) {
      rows.push({ item: `  ${cat.name}`, amount: cat.amount });
    }
    rows.push({ item: "Total Expenses", amount: pnl.expenses, _isSubtotal: true });
    rows.push({ item: "Net Profit", amount: pnl.grossProfit, _isGrandTotal: true });

    return {
      title: "Financial Report — All Reports",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: dateRangeLabel || "",
      columns: [
        { key: "item", header: "Item", width: 40 },
        { key: "amount", header: "Amount", width: 20, format: "currency", align: "right" },
      ],
      rows,
      sheetName: "Financial Report",
    };
  }, [pnl, expensesByCategory, currentOrg, dateRangeLabel]);

  return (
    <ReportsLayout>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Reports</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Financial reports and analytics
            </p>
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="flex-1 sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="this_month">This Month</SelectItem>
                <SelectItem value="last_month">Last Month</SelectItem>
                <SelectItem value="last_3_months">Last 3 Months</SelectItem>
                <SelectItem value="last_6_months">Last 6 Months</SelectItem>
                <SelectItem value="this_year">This Year</SelectItem>
              </SelectContent>
            </Select>
            <ReportExportButtons getExportConfig={getExportConfig} />
          </div>
        </div>

        {(isLoading || !currencyReady) ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="stats-grid">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2 sm:p-6 sm:pb-2">
                  <CardTitle className="text-xs sm:text-sm font-medium">Revenue</CardTitle>
                  <TrendingUp className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-success shrink-0" />
                </CardHeader>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="stat-value text-success">
                    {formatCurrency(pnl.revenue, baseCurrency)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{dateRangeLabel}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2 sm:p-6 sm:pb-2">
                  <CardTitle className="text-xs sm:text-sm font-medium">Expenses</CardTitle>
                  <TrendingDown className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-destructive shrink-0" />
                </CardHeader>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="stat-value text-destructive">
                    {formatCurrency(pnl.expenses, baseCurrency)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{dateRangeLabel}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2 sm:p-6 sm:pb-2">
                  <CardTitle className="text-xs sm:text-sm font-medium">Net Profit</CardTitle>
                  <Coins
                    className={`h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 ${pnl.grossProfit >= 0 ? "text-success" : "text-destructive"}`}
                  />
                </CardHeader>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div
                    className={`stat-value ${pnl.grossProfit >= 0 ? "text-success" : "text-destructive"}`}
                  >
                    {formatCurrency(pnl.grossProfit, baseCurrency)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{dateRangeLabel}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2 sm:p-6 sm:pb-2">
                  <CardTitle className="text-xs sm:text-sm font-medium">Outstanding</CardTitle>
                  <FileText className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground shrink-0" />
                </CardHeader>
                <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                  <div className="stat-value">
                    {formatCurrency(
                      invoiceAging.current +
                        invoiceAging.days30 +
                        invoiceAging.days60 +
                        invoiceAging.days90 +
                        invoiceAging.over90,
                      baseCurrency
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Accounts receivable</p>
                </CardContent>
              </Card>
            </div>

            {/* Visual Charts Section */}
            <div className="grid gap-4 sm:gap-6 grid-cols-1 lg:grid-cols-2">
              <ReportCharts
                chartId="expense-chart"
                title="Expense Breakdown"
                description={dateRangeLabel}
                chartType={expenseChartType}
                onChartTypeChange={setExpenseChartType}
                data={expenseChartData}
                formatValue={(v) => formatCurrency(v, baseCurrency)}
                currencySymbol={currencySymbol}
              />
              <ReportCharts
                chartId="aging-chart"
                title="Invoice Aging"
                description="Outstanding balances by age"
                chartType={agingChartType}
                onChartTypeChange={setAgingChartType}
                data={agingChartData}
                formatValue={(v) => formatCurrency(v, baseCurrency)}
                currencySymbol={currencySymbol}
              />
            </div>

            {/* Report Tabs */}
            <Tabs defaultValue="pnl" className="space-y-4">
              <TabsList className="responsive-tabs">
                <TabsTrigger value="pnl" className="text-xs sm:text-sm">Profit & Loss</TabsTrigger>
                <TabsTrigger value="balance" className="text-xs sm:text-sm">Balance Sheet</TabsTrigger>
                <TabsTrigger value="expenses" className="text-xs sm:text-sm">Expense Details</TabsTrigger>
                <TabsTrigger value="aging" className="text-xs sm:text-sm">Invoice Aging</TabsTrigger>
              </TabsList>

              <TabsContent value="pnl">
                <Card>
                  <CardHeader className="p-4 sm:p-6">
                    <CardTitle className="text-sm sm:text-base">Profit & Loss Statement</CardTitle>
                    <CardDescription className="text-xs sm:text-sm">{dateRangeLabel}</CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                    <Table>
                      <TableBody>
                        <TableRow className="font-medium bg-muted/50">
                          <TableCell colSpan={2} className="text-xs sm:text-sm">Revenue</TableCell>
                        </TableRow>
                        {pnlReport?.sections["income"]?.map((acct) => (
                          <TableRow key={acct.id}>
                            <TableCell className="pl-6 sm:pl-8 text-xs sm:text-sm">{acct.name}</TableCell>
                            <TableCell className="text-right text-xs sm:text-sm">
                              {formatCurrency(acct.display_amount, baseCurrency)}
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="font-medium">
                          <TableCell className="text-xs sm:text-sm">Total Revenue</TableCell>
                          <TableCell className="text-right text-success text-xs sm:text-sm">
                            {formatCurrency(pnl.revenue, baseCurrency)}
                          </TableCell>
                        </TableRow>
                        <TableRow className="font-medium bg-muted/50">
                          <TableCell colSpan={2} className="text-xs sm:text-sm">Expenses</TableCell>
                        </TableRow>
                        {expensesByCategory.map((cat) => (
                          <TableRow key={cat.name}>
                            <TableCell className="pl-6 sm:pl-8 text-xs sm:text-sm">{cat.name}</TableCell>
                            <TableCell className="text-right text-xs sm:text-sm">
                              {formatCurrency(cat.amount, baseCurrency)}
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="font-medium">
                          <TableCell className="text-xs sm:text-sm">Total Expenses</TableCell>
                          <TableCell className="text-right text-destructive text-xs sm:text-sm">
                            {formatCurrency(pnl.expenses, baseCurrency)}
                          </TableCell>
                        </TableRow>
                        <TableRow className="font-bold text-sm sm:text-lg border-t-2">
                          <TableCell>Net Profit</TableCell>
                          <TableCell
                            className={`text-right ${pnl.grossProfit >= 0 ? "text-success" : "text-destructive"}`}
                          >
                            {formatCurrency(pnl.grossProfit, baseCurrency)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="balance">
                <Card>
                  <CardHeader className="p-4 sm:p-6">
                    <CardTitle className="text-sm sm:text-base">Balance Sheet Summary</CardTitle>
                    <CardDescription className="text-xs sm:text-sm">As of {format(new Date(), "MMMM d, yyyy")}</CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                    <Table>
                      <TableBody>
                        <TableRow className="font-medium">
                          <TableCell className="text-xs sm:text-sm">Total Assets</TableCell>
                          <TableCell className="text-right text-xs sm:text-sm">
                            {formatCurrency(balanceSheet.totalAssets, baseCurrency)}
                          </TableCell>
                        </TableRow>
                        <TableRow className="font-medium">
                          <TableCell className="text-xs sm:text-sm">Total Liabilities</TableCell>
                          <TableCell className="text-right text-xs sm:text-sm">
                            {formatCurrency(balanceSheet.totalLiabilities, baseCurrency)}
                          </TableCell>
                        </TableRow>
                        <TableRow className="font-medium">
                          <TableCell className="text-xs sm:text-sm">Total Equity</TableCell>
                          <TableCell className="text-right text-xs sm:text-sm">
                            {formatCurrency(balanceSheet.totalEquity, baseCurrency)}
                          </TableCell>
                        </TableRow>
                        <TableRow className="font-bold text-sm sm:text-lg border-t-2">
                          <TableCell>Total Liabilities + Equity</TableCell>
                          <TableCell className="text-right">
                            {formatCurrency(balanceSheet.totalLiabilities + balanceSheet.totalEquity, baseCurrency)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                    <div className="mt-4 text-center">
                      <a
                        href="/reports-app/financial-reports"
                        className="text-sm text-primary hover:underline"
                      >
                        View detailed Balance Sheet →
                      </a>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="expenses">
                <Card>
                  <CardHeader className="p-4 sm:p-6">
                    <CardTitle className="text-sm sm:text-base">Expense Breakdown by Category</CardTitle>
                    <CardDescription className="text-xs sm:text-sm">{dateRangeLabel}</CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                    {expensesByCategory.length === 0 ? (
                      <p className="text-center text-sm text-muted-foreground py-8">
                        No expenses recorded for this period.
                      </p>
                    ) : (
                      <div className="space-y-3 sm:space-y-4">
                        {expensesByCategory.map((cat) => (
                          <div key={cat.name} className="flex items-center gap-3 sm:gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex justify-between mb-1">
                                <span className="text-xs sm:text-sm font-medium truncate">{cat.name}</span>
                                <span className="text-xs sm:text-sm ml-2 shrink-0">{formatCurrency(cat.amount, baseCurrency)}</span>
                              </div>
                              <div className="h-2 bg-muted rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-primary rounded-full"
                                  style={{
                                    width: `${(cat.amount / pnl.expenses) * 100}%`,
                                  }}
                                />
                              </div>
                            </div>
                            <span className="text-xs text-muted-foreground w-10 sm:w-12 text-right shrink-0">
                              {((cat.amount / pnl.expenses) * 100).toFixed(1)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="aging">
                <Card>
                  <CardHeader className="p-4 sm:p-6">
                    <CardTitle className="text-sm sm:text-base">Accounts Receivable Aging</CardTitle>
                    <CardDescription className="text-xs sm:text-sm">Outstanding invoice balances by age</CardDescription>
                  </CardHeader>
                  <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs sm:text-sm">Aging Period</TableHead>
                          <TableHead className="text-right text-xs sm:text-sm">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow>
                          <TableCell className="text-xs sm:text-sm">Current (not yet due)</TableCell>
                          <TableCell className="text-right text-xs sm:text-sm">
                            {formatCurrency(invoiceAging.current, baseCurrency)}
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="text-xs sm:text-sm">1-30 days overdue</TableCell>
                          <TableCell className="text-right text-xs sm:text-sm">
                            {formatCurrency(invoiceAging.days30, baseCurrency)}
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="text-xs sm:text-sm">31-60 days overdue</TableCell>
                          <TableCell className="text-right text-xs sm:text-sm">
                            {formatCurrency(invoiceAging.days60, baseCurrency)}
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="text-xs sm:text-sm">61-90 days overdue</TableCell>
                          <TableCell className="text-right text-xs sm:text-sm">
                            {formatCurrency(invoiceAging.days90, baseCurrency)}
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell className="text-xs sm:text-sm">Over 90 days overdue</TableCell>
                          <TableCell className="text-right text-destructive text-xs sm:text-sm">
                            {formatCurrency(invoiceAging.over90, baseCurrency)}
                          </TableCell>
                        </TableRow>
                        <TableRow className="font-bold border-t">
                          <TableCell className="text-xs sm:text-sm">Total Outstanding</TableCell>
                          <TableCell className="text-right text-xs sm:text-sm">
                            {formatCurrency(
                              invoiceAging.current +
                                invoiceAging.days30 +
                                invoiceAging.days60 +
                                invoiceAging.days90 +
                                invoiceAging.over90,
                              baseCurrency
                            )}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>

    </ReportsLayout>
  );
}