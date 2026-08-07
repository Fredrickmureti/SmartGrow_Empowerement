/**
 * Budget vs Actual Report Page
 * 
 * Side-by-side comparison of budget amounts vs actual journal entry totals
 * with variance calculation by account and period.
 *
 * Rendered by the canonical reporting engine (`@/design-system/reports`).
 */

import { useState, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, TrendingUp, TrendingDown, Target } from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBudgets } from "@/hooks/useBudgets";
import { useBudgetVsActual } from "@/hooks/useBudgetVsActual";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { DrillDownDialog, type DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { cn } from "@/lib/utils";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { ReportFilterProvider } from "@/contexts/ReportFilterContext";
import {
  ReportSurface,
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

function BudgetReportInner() {
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>("");
  const [drillDown, setDrillDown] = useState<DrillDownConfig | null>(null);

  const { currentOrg } = useOrganization();
  const { budgets } = useBudgets();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  // Budget vs Actual is intrinsically scoped by the *budget's* own branch_id
  // (a Branch A budget compares to Branch A actuals — see useBudgetVsActual).
  // The toolbar branch filter from ReportPageLayout still drives which budgets
  // appear in the dropdown via useBudgets().

  const activeBudgets = budgets.filter((b) => b.status === "active" || b.status === "draft");

  const {
    selectedBudget,
    storedActuals,
    isLoading,
    calculateActuals,
    getVarianceReport,
    getChartData,
  } = useBudgetVsActual(selectedBudgetId || undefined);

  const varianceReport = selectedBudget ? getVarianceReport(selectedBudget) : null;
  const chartData = selectedBudget ? getChartData(selectedBudget) : [];

  const handleCalculateActuals = () => {
    if (selectedBudget) {
      calculateActuals.mutate(selectedBudget);
    }
  };

  const getStatusBadge = (status: "under" | "over" | "on_track") => {
    switch (status) {
      case "over":
        return <Badge variant="destructive">Over Budget</Badge>;
      case "under":
        return <Badge className="bg-green-600 hover:bg-green-700 text-white">Under Budget</Badge>;
      default:
        return <Badge variant="secondary">On Track</Badge>;
    }
  };

  // Build a per-account summary from variance report
  const accountSummaries = useMemo(() => {
    if (!varianceReport) return [];
    const map = new Map<string, { accountId: string; accountCode: string; accountName: string; budgeted: number; actual: number; variance: number; variancePercent: number; status: "under" | "over" | "on_track" }>();
    varianceReport.itemsByAccount.forEach((items, accountId) => {
      const budgeted = items.reduce((s, i) => s + i.budgeted, 0);
      const actual = items.reduce((s, i) => s + i.actual, 0);
      const variance = budgeted - actual;
      const variancePercent = budgeted > 0 ? (variance / budgeted) * 100 : 0;
      let status: "under" | "over" | "on_track" = "on_track";
      if (variancePercent < -10) status = "over";
      else if (variancePercent > 10) status = "under";
      map.set(accountId, {
        accountId,
        accountCode: items[0]?.accountCode || "",
        accountName: items[0]?.accountName || "Unknown",
        budgeted, actual, variance, variancePercent, status,
      });
    });
    return Array.from(map.values()).sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  }, [varianceReport]);

  // ── One column declaration drives the screen table AND the export ──
  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "code", header: "Code", width: "w-[90px]" },
      { key: "name", header: "Account" },
      { key: "budgeted", header: "Budgeted", format: "currency", width: "w-[140px]" },
      { key: "actual", header: "Actual", format: "currency", width: "w-[140px]" },
      { key: "variance", header: "Variance", format: "currency", width: "w-[140px]" },
      { key: "variance_pct", header: "Var %", format: "percent", width: "w-[90px]" },
      {
        key: "status",
        header: "Status",
        align: "center",
        width: "w-[130px]",
        exportExclude: true,
        render: (row) => {
          const status = (row.values as any)?.status as "under" | "over" | "on_track" | undefined;
          return status ? getStatusBadge(status) : null;
        },
      },
    ],
    [],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = accountSummaries.map((a) => ({
      id: a.accountId,
      onClick: selectedBudget
        ? () => setDrillDown({
            title: `${a.accountCode} - ${a.accountName}`,
            accountId: a.accountId,
            startDate: `${selectedBudget.fiscal_year}-01-01`,
            endDate: `${selectedBudget.fiscal_year}-12-31`,
          })
        : undefined,
      values: {
        code: a.accountCode,
        name: a.accountName,
        budgeted: a.budgeted,
        actual: a.actual,
        variance: a.variance,
        variance_pct: a.variancePercent,
        status: a.status,
      },
    }));

    if (varianceReport) {
      out.push({
        id: "grand-total",
        kind: "grandTotal",
        label: "TOTAL",
        values: {
          budgeted: varianceReport.totalBudgeted,
          actual: varianceReport.totalActual,
          variance: varianceReport.totalVariance,
          variance_pct: varianceReport.variancePercent,
        },
      });
    }

    return out;
  }, [accountSummaries, varianceReport, selectedBudget]);

  const getExportConfig = useCallback((): ExportConfig => ({
    title: `Budget vs Actual – ${selectedBudget?.name || ""}`,
    companyName: currentOrg?.name || "",
    organizationId: currentOrg?.id,
    dateRange: `Fiscal Year ${selectedBudget?.fiscal_year || ""}`,
    columns: toExportColumns(columns),
    rows: toExportRows(rows, columns),
    sheetName: "Budget vs Actual",
    currency: baseCurrency,
  }), [columns, rows, selectedBudget, currentOrg, baseCurrency]);

  return (
    <ReportPageLayout
      title="Budget vs Actual"
      description="Compare budgeted amounts against actual journal entry totals"
      isLoading={isLoading || !currencyReady}
      isEmpty={!selectedBudgetId}
      emptyMessage="Select a budget to view the variance analysis"
      getExportConfig={selectedBudgetId && varianceReport ? getExportConfig : undefined}
      headerActions={
        <div className="flex items-center gap-2">
          <RefreshButton queryKeyPrefixes={[['budget-vs-actual'] as const]} tooltip="Refresh budget report" />
          {selectedBudget && (
            <Badge variant="outline">FY {selectedBudget.fiscal_year}</Badge>
          )}
          <SaveViewButton
            reportType="budget"
            currentFilters={{ selectedBudgetId }}
            onLoadView={(filters) => {
              if (filters.selectedBudgetId) setSelectedBudgetId(filters.selectedBudgetId);
            }}
          />
        </div>
      }
      filters={
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[200px] max-w-xs">
            <Select value={selectedBudgetId} onValueChange={setSelectedBudgetId}>
              <SelectTrigger>
                <SelectValue placeholder="Select budget…" />
              </SelectTrigger>
              <SelectContent>
                {activeBudgets.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name} ({b.fiscal_year})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedBudget && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCalculateActuals}
              disabled={calculateActuals.isPending}
            >
              <RefreshCw className={cn("h-4 w-4 mr-2", calculateActuals.isPending && "animate-spin")} />
              {storedActuals.length > 0 ? "Refresh Actuals" : "Calculate Actuals"}
            </Button>
          )}
        </div>
      }
    >
      {varianceReport && (
        <div className="space-y-6">
          {/* KPI Cards */}
          <div className="stats-grid">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Budgeted</CardTitle>
                <Target className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(varianceReport.totalBudgeted, baseCurrency)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Actual</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(varianceReport.totalActual, baseCurrency)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Variance</CardTitle>
                {varianceReport.totalVariance >= 0 ? (
                  <TrendingDown className="h-4 w-4 text-green-600" />
                ) : (
                  <TrendingUp className="h-4 w-4 text-destructive" />
                )}
              </CardHeader>
              <CardContent>
                <div className={cn("text-2xl font-bold", varianceReport.totalVariance >= 0 ? "text-green-600" : "text-destructive")}>
                  {formatCurrency(varianceReport.totalVariance, baseCurrency)}
                </div>
                <p className="text-xs text-muted-foreground">{varianceReport.variancePercent.toFixed(1)}%</p>
              </CardContent>
            </Card>
          </div>

          {/* Chart */}
          {chartData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Monthly Budget vs Actual</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="month" className="text-xs fill-muted-foreground" />
                    <YAxis className="text-xs fill-muted-foreground" />
                    <Tooltip
                      formatter={(value: number) => formatCurrency(value, baseCurrency)}
                      contentStyle={{ borderRadius: "8px", border: "1px solid hsl(var(--border))" }}
                    />
                    <Legend />
                    <Bar dataKey="budgeted" fill="hsl(var(--primary))" name="Budgeted" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="actual" fill="hsl(var(--accent))" name="Actual" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Account Detail Table, rendered by the shared reporting engine */}
          <ReportSurface
            companyName={currentOrg?.name || ""}
            title="Budget vs Actual"
            subtitle={selectedBudget ? `${selectedBudget.name} — FY ${selectedBudget.fiscal_year}` : undefined}
            profile="financial"
          >
            <ReportTable
              columns={columns}
              rows={rows}
              currency={baseCurrency}
              caption="Variance by account"
              emptyMessage="No budget lines for this budget"
            />
          </ReportSurface>
        </div>
      )}

      <DrillDownDialog
        open={!!drillDown}
        onOpenChange={(open) => !open && setDrillDown(null)}
        config={drillDown}
      />
    </ReportPageLayout>
  );
}


export default function BudgetReport() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Budget report">
        <BudgetReportInner />
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
