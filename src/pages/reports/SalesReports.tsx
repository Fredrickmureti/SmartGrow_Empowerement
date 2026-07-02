import { useState, useMemo, useCallback } from "react";
import { DrillDownDialog, DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { useOrganization } from "@/hooks/useOrganization";
import { useInvoices } from "@/hooks/useInvoices";
import { useContacts } from "@/hooks/useContacts";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, ShoppingCart, TrendingUp, Receipt } from "lucide-react";
import { format, startOfMonth, endOfMonth, subMonths, isWithinInterval } from "date-fns";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";
function SalesReportsInner() {
  const { currentOrg } = useOrganization();
  const { invoices, isLoading: invoicesLoading } = useInvoices();
  const { contacts } = useContacts();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const [dateRange, setDateRange] = useState("this_month");
  const [drillDown, setDrillDown] = useState<{ open: boolean; config: DrillDownConfig | null }>({ open: false, config: null });

  const isLoading = invoicesLoading || !currencyReady;

  const getDateRange = () => {
    const now = new Date();
    switch (dateRange) {
      case "this_month":
        return { start: startOfMonth(now), end: endOfMonth(now) };
      case "last_month":
        return { start: startOfMonth(subMonths(now, 1)), end: endOfMonth(subMonths(now, 1)) };
      case "last_3_months":
        return { start: startOfMonth(subMonths(now, 2)), end: endOfMonth(now) };
      case "this_year":
        return { start: new Date(now.getFullYear(), 0, 1), end: new Date(now.getFullYear(), 11, 31) };
      default:
        return { start: startOfMonth(now), end: endOfMonth(now) };
    }
  };

  const { start, end } = getDateRange();

  const VALID_SALES_STATUSES = ["sent", "viewed", "partial", "paid", "overdue"];

  const salesData = useMemo(() => {
    const filteredInvoices = invoices.filter((inv) => {
      const date = new Date(inv.issue_date);
      return isWithinInterval(date, { start, end }) && VALID_SALES_STATUSES.includes(inv.status);
    });

    const totalSales = filteredInvoices.reduce((sum, i) => sum + i.total, 0);
    const paidSales = filteredInvoices.filter((i) => i.status === "paid").reduce((sum, i) => sum + i.total, 0);
    const pendingSales = filteredInvoices.filter((i) => ["sent", "viewed", "partial", "overdue"].includes(i.status)).reduce((sum, i) => sum + (i.total - i.amount_paid), 0);

    const customerSales: Record<string, { name: string; total: number; count: number }> = {};
    filteredInvoices.forEach((inv) => {
      const customerId = inv.contact_id || "unknown";
      const customerName = inv.contact?.name || "Unknown Customer";
      if (!customerSales[customerId]) {
        customerSales[customerId] = { name: customerName, total: 0, count: 0 };
      }
      customerSales[customerId].total += inv.total;
      customerSales[customerId].count += 1;
    });

    const topCustomers = Object.values(customerSales)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    const monthlyBreakdown: Record<string, number> = {};
    filteredInvoices.forEach((inv) => {
      const month = format(new Date(inv.issue_date), "MMM yyyy");
      monthlyBreakdown[month] = (monthlyBreakdown[month] || 0) + inv.total;
    });

    return {
      filteredInvoices,
      totalSales,
      paidSales,
      pendingSales,
      invoiceCount: filteredInvoices.length,
      avgInvoiceValue: filteredInvoices.length > 0 ? totalSales / filteredInvoices.length : 0,
      topCustomers,
      monthlyBreakdown: Object.entries(monthlyBreakdown).map(([month, total]) => ({ month, total })),
    };
  }, [invoices, start, end]);

  const getExportConfig = useCallback((): ExportConfig => {
    const rows: ExportRow[] = [];

    // Summary section
    rows.push({ item: "SALES SUMMARY", amount: null, _isHeader: true });
    rows.push({ item: "Total Sales", amount: salesData.totalSales, _depth: 1 });
    rows.push({ item: "Collected", amount: salesData.paidSales, _depth: 1 });
    rows.push({ item: "Outstanding", amount: salesData.pendingSales, _depth: 1 });
    rows.push({ item: "Invoice Count", amount: salesData.invoiceCount, _depth: 1 });
    rows.push({ item: "Average Invoice Value", amount: salesData.avgInvoiceValue, _depth: 1 });
    rows.push({ item: "", amount: null });

    // Top customers
    rows.push({ item: "TOP CUSTOMERS", amount: null, _isHeader: true });
    for (const c of salesData.topCustomers) {
      rows.push({ item: `${c.name} (${c.count} invoices)`, amount: c.total, _depth: 1 });
    }
    if (salesData.topCustomers.length > 0) {
      rows.push({
        item: "Total (Top Customers)",
        amount: salesData.topCustomers.reduce((s, c) => s + c.total, 0),
        _isSubtotal: true,
      });
    }
    rows.push({ item: "", amount: null });

    // Monthly breakdown
    rows.push({ item: "MONTHLY BREAKDOWN", amount: null, _isHeader: true });
    for (const m of salesData.monthlyBreakdown) {
      rows.push({ item: m.month, amount: m.total, _depth: 1 });
    }

    return {
      title: "Sales Report",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(start, "MMM d, yyyy")} – ${format(end, "MMM d, yyyy")}`,
      columns: [
        { key: "item", header: "Description", width: 50 },
        { key: "amount", header: "Amount", width: 20, format: "currency", align: "right" },
      ],
      rows,
      sheetName: "Sales Report",
      currency: baseCurrency,
    };
  }, [salesData, start, end, currentOrg, baseCurrency]);

  return (
    <ReportPageLayout
      title="Sales Reports"
      description="Sales performance and customer analytics"
      isLoading={isLoading}
      isEmpty={salesData.invoiceCount === 0}
      emptyMessage="No sales data available for the selected period"
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['sales-orders'] as const, ['invoices'] as const]} tooltip="Refresh sales reports" />
          <SaveViewButton
            reportType="sales"
            currentFilters={{ dateRange }}
            onLoadView={(filters) => {
              if (filters.dateRange) setDateRange(filters.dateRange);
            }}
          />
        </>
      }
      filters={
        <Select value={dateRange} onValueChange={setDateRange}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="this_month">This Month</SelectItem>
            <SelectItem value="last_month">Last Month</SelectItem>
            <SelectItem value="last_3_months">Last 3 Months</SelectItem>
            <SelectItem value="this_year">This Year</SelectItem>
          </SelectContent>
        </Select>
      }
    >
      <div className="space-y-6">
        <div className="stats-grid">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Sales</CardTitle>
              <ShoppingCart className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                {formatCurrency(salesData.totalSales, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">{salesData.invoiceCount} invoices</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Collected</CardTitle>
              <TrendingUp className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">
                {formatCurrency(salesData.paidSales, baseCurrency)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Outstanding</CardTitle>
              <Receipt className="h-4 w-4 text-orange-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-orange-600">
                {formatCurrency(salesData.pendingSales, baseCurrency)}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Avg Invoice</CardTitle>
              <Users className="h-4 w-4 text-purple-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-purple-600">
                {formatCurrency(salesData.avgInvoiceValue, baseCurrency)}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Top Customers</CardTitle>
              <CardDescription>By revenue generated</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-center">Invoices</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {salesData.topCustomers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center py-8 text-muted-foreground">
                        No sales data available
                      </TableCell>
                    </TableRow>
                  ) : (
                    salesData.topCustomers.map((customer, index) => (
                      <TableRow key={index}>
                        <TableCell className="font-medium">{customer.name}</TableCell>
                        <TableCell className="text-center">{customer.count}</TableCell>
                        <TableCell className="text-right">
                          <button className="hover:underline hover:text-primary cursor-pointer" onClick={() => setDrillDown({ open: true, config: { title: `Sales — ${customer.name}`, startDate: format(start, "yyyy-MM-dd"), endDate: format(end, "yyyy-MM-dd"), sourceType: "invoice" } })}>
                            {formatCurrency(customer.total, baseCurrency)}
                          </button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Monthly Sales</CardTitle>
              <CardDescription>Sales breakdown by month</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Sales</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {salesData.monthlyBreakdown.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={2} className="text-center py-8 text-muted-foreground">
                        No sales data available
                      </TableCell>
                    </TableRow>
                  ) : (
                    salesData.monthlyBreakdown.map((item, index) => (
                      <TableRow key={index}>
                        <TableCell className="font-medium">{item.month}</TableCell>
                        <TableCell className="text-right">{formatCurrency(item.total, baseCurrency)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
      <DrillDownDialog
        open={drillDown.open}
        onOpenChange={(open) => setDrillDown((prev) => ({ ...prev, open }))}
        config={drillDown.config}
      />
    </ReportPageLayout>
  );
}


export default function SalesReports() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Sales reports">
        <SalesReportsInner />
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
