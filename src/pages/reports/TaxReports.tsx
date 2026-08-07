import { useState, useMemo, useCallback } from "react";
import { DrillDownDialog, DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { useOrganization } from "@/hooks/useOrganization";
import { useInvoices } from "@/hooks/useInvoices";
import { useExpenses } from "@/hooks/useExpenses";
import { useBills } from "@/hooks/useBills";
import { useTaxRates } from "@/hooks/useTaxRates";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Receipt, TrendingUp, TrendingDown, Calculator } from "lucide-react";
import { format, startOfMonth, endOfMonth, subMonths, startOfQuarter, endOfQuarter, isWithinInterval } from "date-fns";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";
function TaxReportsInner() {
  const { currentOrg } = useOrganization();
  const { invoices, isLoading: invoicesLoading } = useInvoices();
  const { expenses, isLoading: expensesLoading } = useExpenses();
  const { bills, isLoading: billsLoading } = useBills();
  const { taxRates, isLoading: taxLoading } = useTaxRates();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const [period, setPeriod] = useState("this_quarter");
  const [drillDown, setDrillDown] = useState<{ open: boolean; config: DrillDownConfig | null }>({ open: false, config: null });

  const isLoading = invoicesLoading || expensesLoading || billsLoading || taxLoading || !currencyReady;

  const getDateRange = () => {
    const now = new Date();
    switch (period) {
      case "this_month":
        return { start: startOfMonth(now), end: endOfMonth(now) };
      case "last_month":
        return { start: startOfMonth(subMonths(now, 1)), end: endOfMonth(subMonths(now, 1)) };
      case "this_quarter":
        return { start: startOfQuarter(now), end: endOfQuarter(now) };
      case "last_quarter":
        return { start: startOfQuarter(subMonths(now, 3)), end: endOfQuarter(subMonths(now, 3)) };
      case "this_year":
        return { start: new Date(now.getFullYear(), 0, 1), end: new Date(now.getFullYear(), 11, 31) };
      default:
        return { start: startOfQuarter(now), end: endOfQuarter(now) };
    }
  };

  const { start, end } = getDateRange();

  const taxData = useMemo(() => {
    const filteredInvoices = invoices.filter((inv) => {
      const date = new Date(inv.issue_date);
      return isWithinInterval(date, { start, end }) && inv.status === "paid";
    });

    const salesTaxCollected = filteredInvoices.reduce((sum, inv) => sum + inv.tax_amount, 0);
    const totalSales = filteredInvoices.reduce((sum, inv) => sum + inv.subtotal, 0);

    const filteredBills = bills.filter((bill) => {
      const date = new Date(bill.bill_date);
      return isWithinInterval(date, { start, end }) && bill.status === "paid";
    });

    const purchaseTaxPaid = filteredBills.reduce((sum, bill) => sum + bill.tax_amount, 0);
    const totalPurchases = filteredBills.reduce((sum, bill) => sum + bill.subtotal, 0);

    const filteredExpenses = expenses.filter((exp) => {
      const date = new Date(exp.expense_date);
      return isWithinInterval(date, { start, end }) && (exp.status === "approved" || exp.status === "paid");
    });

    const expenseTax = filteredExpenses.reduce((sum, exp) => sum + (exp.tax_amount || 0), 0);
    const netTaxLiability = salesTaxCollected - purchaseTaxPaid - expenseTax;

    const taxBreakdown: Record<string, { rate: number; salesTax: number; purchaseTax: number }> = {};

    filteredInvoices.forEach((inv) => {
      const rate = inv.subtotal > 0 ? (inv.tax_amount / inv.subtotal * 100) : 0;
      const rateKey = rate.toFixed(0);
      if (!taxBreakdown[rateKey]) {
        taxBreakdown[rateKey] = { rate, salesTax: 0, purchaseTax: 0 };
      }
      taxBreakdown[rateKey].salesTax += inv.tax_amount;
    });

    filteredBills.forEach((bill) => {
      const rate = bill.subtotal > 0 ? (bill.tax_amount / bill.subtotal * 100) : 0;
      const rateKey = rate.toFixed(0);
      if (!taxBreakdown[rateKey]) {
        taxBreakdown[rateKey] = { rate, salesTax: 0, purchaseTax: 0 };
      }
      taxBreakdown[rateKey].purchaseTax += bill.tax_amount;
    });

    return {
      salesTaxCollected,
      purchaseTaxPaid,
      expenseTax,
      netTaxLiability,
      totalSales,
      totalPurchases,
      taxBreakdown: Object.entries(taxBreakdown)
        .map(([key, data]) => ({ rateKey: key, ...data }))
        .sort((a, b) => b.rate - a.rate),
    };
  }, [invoices, bills, expenses, start, end]);

  const periodLabel = {
    this_month: format(start, "MMMM yyyy"),
    last_month: format(start, "MMMM yyyy"),
    this_quarter: `Q${Math.ceil((start.getMonth() + 1) / 3)} ${format(start, "yyyy")}`,
    last_quarter: `Q${Math.ceil((start.getMonth() + 1) / 3)} ${format(start, "yyyy")}`,
    this_year: format(start, "yyyy"),
  }[period];

  // ── Tax Summary: one column + row declaration drives the screen table AND the export ──
  const summaryColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "label", header: "Description", width: "w-[280px]" },
      { key: "amount", header: "Amount", format: "currency", width: "w-[160px]" },
    ],
    [],
  );

  const summaryRows = useMemo<ReportRow[]>(
    () => [
      { id: "output-header", kind: "section", label: "Output Tax (Collected)" },
      { id: "total-sales", depth: 1, label: "Total Sales (excl. tax)", values: { amount: taxData.totalSales } },
      {
        id: "sales-tax",
        depth: 1,
        label: "Sales Tax Collected",
        tone: "success",
        onClick: () => setDrillDown({
          open: true,
          config: {
            title: "Sales Tax Collected",
            startDate: format(start, "yyyy-MM-dd"),
            endDate: format(end, "yyyy-MM-dd"),
            sourceType: "invoice",
          },
        }),
        values: { amount: taxData.salesTaxCollected },
      },
      { id: "input-header", kind: "section", label: "Input Tax (Paid)" },
      { id: "total-purchases", depth: 1, label: "Total Purchases (excl. tax)", values: { amount: taxData.totalPurchases } },
      { id: "purchase-tax", depth: 1, label: "Purchase Tax Paid", values: { amount: taxData.purchaseTaxPaid } },
      { id: "expense-tax", depth: 1, label: "Expense Tax Paid", values: { amount: taxData.expenseTax } },
      {
        id: "net-tax",
        kind: "grandTotal",
        label: `Net Tax ${taxData.netTaxLiability >= 0 ? "Payable" : "Refund"}`,
        tone: taxData.netTaxLiability >= 0 ? "danger" : "success",
        values: { amount: Math.abs(taxData.netTaxLiability) },
      },
    ],
    [taxData, start, end],
  );

  // ── Tax Breakdown by Rate ──
  const breakdownColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "rate", header: "Tax Rate", width: "w-[110px]" },
      { key: "salesTax", header: "Sales Tax", format: "currency", width: "w-[150px]" },
      { key: "purchaseTax", header: "Purchase Tax", format: "currency", width: "w-[150px]" },
      { key: "net", header: "Net", format: "currency", width: "w-[150px] " },
    ],
    [],
  );

  const breakdownRows = useMemo<ReportRow[]>(
    () =>
      taxData.taxBreakdown.map((item) => {
        const net = item.salesTax - item.purchaseTax;
        return {
          id: item.rateKey,
          tone: net >= 0 ? "danger" : "success",
          values: {
            rate: `${item.rate.toFixed(0)}%`,
            salesTax: item.salesTax,
            purchaseTax: item.purchaseTax,
            net,
          },
        };
      }),
    [taxData],
  );

  const getExportConfig = useCallback((): ExportConfig => {
    const rows: ExportRow[] = [];

    // Tax Summary section
    rows.push({ item: "OUTPUT TAX (COLLECTED)", amount: null, _isHeader: true });
    rows.push({ item: "Total Sales (excl. tax)", amount: taxData.totalSales, _depth: 1 });
    rows.push({ item: "Sales Tax Collected", amount: taxData.salesTaxCollected, _depth: 1 });
    rows.push({ item: "", amount: null });
    rows.push({ item: "INPUT TAX (PAID)", amount: null, _isHeader: true });
    rows.push({ item: "Total Purchases (excl. tax)", amount: taxData.totalPurchases, _depth: 1 });
    rows.push({ item: "Purchase Tax Paid", amount: taxData.purchaseTaxPaid, _depth: 1 });
    rows.push({ item: "Expense Tax Paid", amount: taxData.expenseTax, _depth: 1 });
    rows.push({ item: "", amount: null });
    rows.push({
      item: `Net Tax ${taxData.netTaxLiability >= 0 ? "Payable" : "Refund"}`,
      amount: taxData.netTaxLiability,
      _isGrandTotal: true,
    });

    // Breakdown by rate
    if (taxData.taxBreakdown.length > 0) {
      rows.push({ item: "", amount: null });
      rows.push({ item: "BREAKDOWN BY TAX RATE", amount: null, _isHeader: true });
      for (const item of taxData.taxBreakdown) {
        rows.push({
          item: `${item.rate.toFixed(0)}% — Sales: ${item.salesTax.toFixed(2)}, Purchases: ${item.purchaseTax.toFixed(2)}`,
          amount: item.salesTax - item.purchaseTax,
          _depth: 1,
        });
      }
    }

    return {
      title: "Tax Report",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(start, "MMM d, yyyy")} – ${format(end, "MMM d, yyyy")}`,
      columns: [
        { key: "item", header: "Description", width: 50 },
        { key: "amount", header: "Amount", width: 20, format: "currency", align: "right" },
      ],
      rows,
      sheetName: "Tax Report",
      currency: baseCurrency,
    };
  }, [taxData, start, end, currentOrg, baseCurrency]);

  return (
    <ReportPageLayout
      title="Tax Reports"
      description="Tax liability summary and breakdown"
      isLoading={isLoading}
      isEmpty={taxData.salesTaxCollected === 0 && taxData.purchaseTaxPaid === 0 && taxData.expenseTax === 0}
      emptyMessage="No tax data available for the selected period"
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['invoices'] as const, ['expenses'] as const]} tooltip="Refresh tax reports" />
          <SaveViewButton
            reportType="tax"
            currentFilters={{ period }}
            onLoadView={(filters) => {
              if (filters.period) setPeriod(filters.period);
            }}
          />
        </>
      }
      filters={
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="this_month">This Month</SelectItem>
            <SelectItem value="last_month">Last Month</SelectItem>
            <SelectItem value="this_quarter">This Quarter</SelectItem>
            <SelectItem value="last_quarter">Last Quarter</SelectItem>
            <SelectItem value="this_year">This Year</SelectItem>
          </SelectContent>
        </Select>
      }
    >
      <div className="space-y-6">
        <div className="stats-grid">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Sales Tax Collected</CardTitle>
              <TrendingUp className="h-4 w-4 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">
                {formatCurrency(taxData.salesTaxCollected, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">Output tax</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Purchase Tax Paid</CardTitle>
              <TrendingDown className="h-4 w-4 text-blue-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">
                {formatCurrency(taxData.purchaseTaxPaid, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">Input tax (bills)</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Expense Tax</CardTitle>
              <Receipt className="h-4 w-4 text-purple-600" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-purple-600">
                {formatCurrency(taxData.expenseTax, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">Input tax (expenses)</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net Tax Liability</CardTitle>
              <Calculator className={`h-4 w-4 ${taxData.netTaxLiability >= 0 ? "text-red-600" : "text-green-600"}`} />
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${taxData.netTaxLiability >= 0 ? "text-red-600" : "text-green-600"}`}>
                {formatCurrency(Math.abs(taxData.netTaxLiability), baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                {taxData.netTaxLiability >= 0 ? "Amount payable" : "Refund due"}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <ReportSurface title="Tax Summary" subtitle={periodLabel} profile="operational">
            <ReportTable
              columns={summaryColumns}
              rows={summaryRows}
              currency={baseCurrency}
              caption="Output and input tax summary with net liability"
            />
          </ReportSurface>

          <ReportSurface title="Tax Breakdown by Rate" subtitle="Tax collected and paid by tax rate" profile="operational">
            <ReportTable
              columns={breakdownColumns}
              rows={breakdownRows}
              currency={baseCurrency}
              caption="Sales and purchase tax by tax rate"
              emptyMessage="No tax data available for this period"
            />
          </ReportSurface>
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


export default function TaxReports() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Tax reports">
        <TaxReportsInner />
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
