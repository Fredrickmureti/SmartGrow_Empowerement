/**
 * Budget vs Actual Report Page
 *
 * One reporting surface for budget variance. Every figure comes from the
 * authoritative database report (`get_budget_variance_report` via
 * `useBudgetVsActual`): posted, non-closing, non-opening, non-sample ledger
 * activity inside the business's own monthly fiscal periods and the budget's
 * business/branch scope.
 *
 * Variance is favourable-positive by account nature: underspending a cost
 * account and over-earning a revenue account both read as favourable.
 *
 * Rendered by the canonical reporting engine (`@/design-system/reports`).
 */

import { useState, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, TrendingUp, TrendingDown, Target } from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBudgets } from "@/hooks/useBudgets";
import { useBudgetVsActual, type BudgetVarianceStatus } from "@/hooks/useBudgetVsActual";
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

function statusBadge(status: BudgetVarianceStatus) {
  switch (status) {
    case "unfavourable":
      return <Badge variant="destructive">Unfavourable</Badge>;
    case "favourable":
      return <Badge className="bg-green-600 hover:bg-green-700 text-white">Favourable</Badge>;
    default:
      return <Badge variant="secondary">On Track</Badge>;
  }
}

function BudgetReportInner() {
  const [selectedBudgetId, setSelectedBudgetId] = useState<string>("");
  const [drillDown, setDrillDown] = useState<DrillDownConfig | null>(null);

  const { currentOrg } = useOrganization();
  const { budgets } = useBudgets();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  // Budget vs Actual is intrinsically scoped by the *budget's* own branch_id
  // (a Branch A budget compares to Branch A actuals — enforced in SQL).
  // The toolbar branch filter still drives which budgets appear below.

  const selectableBudgets = budgets.filter((b) => b.status === "active" || b.status === "draft" || b.status === "closed");

  const { selectedBudget, report, isLoading } = useBudgetVsActual(selectedBudgetId || undefined);

  // Period bounds come from the fiscal calendar rows, not the calendar year.
  const periodBounds = useMemo(() => {
    const starts = (report?.rows ?? []).map((r) => r.periodStart).filter(Boolean) as string[];
    const ends = (report?.rows ?? []).map((r) => r.periodEnd).filter(Boolean) as string[];
    if (starts.length && ends.length) {
      return { start: starts.sort()[0], end: ends.sort()[ends.length - 1] };
    }
    const fy = selectedBudget?.fiscal_year;
    return fy ? { start: `${fy}-01-01`, end: `${fy}-12-31` } : null;
  }, [report, selectedBudget]);

  const chartData = useMemo(() => {
    if (!report) return [];
    return report.expenseByMonth.map((point, index) => ({
      month: point.month,
      fullMonth: point.fullMonth,
      budgetedExpense: point.budgeted,
      actualExpense: point.actual,
      budgetedIncome: report.incomeByMonth[index]?.budgeted ?? 0,
      actualIncome: report.incomeByMonth[index]?.actual ?? 0,
    }));
  }, [report]);

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
        width: "w-[140px]",
        exportExclude: true,
        render: (row) => {
          const values = row.values as Record<string, unknown>;
          const status = values?.status as BudgetVarianceStatus | undefined;
          if (!status) return null;
          return (
            <div className="flex items-center justify-center gap-1">
              {statusBadge(status)}
              {values?.unbudgeted ? <Badge variant="outline">Unbudgeted</Badge> : null}
            </div>
          );
        },
      },
    ],
    [],
  );

  const buildRows = useCallback(
    (accountType: "income" | "expense" | "other", label: string): ReportRow[] => {
      if (!report) return [];
      const summaries = report.accountSummaries.filter((a) =>
        accountType === "other"
          ? a.accountType !== "income" && a.accountType !== "expense"
          : a.accountType === accountType,
      );
      if (summaries.length === 0) return [];

      const out: ReportRow[] = summaries.map((a) => ({
        id: `${accountType}-${a.accountId}`,
        onClick: periodBounds
          ? () =>
              setDrillDown({
                title: `${a.accountCode} - ${a.accountName}`,
                accountId: a.accountId,
                startDate: periodBounds.start,
                endDate: periodBounds.end,
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
          unbudgeted: a.unbudgeted,
        },
      }));

      const t = accountType === "income" ? report.income : accountType === "expense" ? report.expense : report.other;
      out.push({
        id: `${accountType}-total`,
        kind: "subtotal",
        label: `Total ${label}`,
        values: {
          budgeted: t.budgeted,
          actual: t.actual,
          variance: t.variance,
          variance_pct: t.variancePercent,
        },
      });
      return out;
    },
    [report, periodBounds],
  );

  const incomeRows = useMemo(() => buildRows("income", "revenue"), [buildRows]);
  const expenseRows = useMemo(() => buildRows("expense", "costs"), [buildRows]);
  const otherRows = useMemo(() => buildRows("other", "other accounts"), [buildRows]);

  const netRow = useMemo<ReportRow[]>(() => {
    if (!report) return [];
    return [
      {
        id: "net-result",
        kind: "grandTotal",
        label: "NET RESULT (revenue − costs)",
        values: {
          budgeted: report.net.budgeted,
          actual: report.net.actual,
          variance: report.net.variance,
          variance_pct: report.net.variancePercent,
        },
      },
    ];
  }, [report]);

  const getExportConfig = useCallback((): ExportConfig => {
    const rows = [...incomeRows, ...expenseRows, ...otherRows, ...netRow];
    return {
      title: `Budget vs Actual – ${selectedBudget?.name || ""}`,
      reportType: "budget_vs_actual",
      companyName: currentOrg?.name || "",
      dateRange: `Fiscal Year ${selectedBudget?.fiscal_year || ""}`,
      columns: toExportColumns(columns),
      rows: toExportRows(rows, columns),
      sheetName: "Budget vs Actual",
      currency: baseCurrency,
    };
  }, [columns, incomeRows, expenseRows, otherRows, netRow, selectedBudget, currentOrg, baseCurrency]);

  const hasData = !!report && report.rows.length > 0;

  return (
    <ReportPageLayout
      title="Budget vs Actual"
      description="Compare the plan against posted ledger activity, by account and fiscal period"
      isLoading={isLoading || !currencyReady}
      isEmpty={!selectedBudgetId}
      emptyState={{
        kind: "missing_prerequisite",
        title: "Select a budget",
        message:
          "Budget vs Actual compares one budget against posted journal activity. Choose a budget above to run the variance analysis.",
      }}
      getExportConfig={selectedBudgetId && hasData ? getExportConfig : undefined}
      headerActions={
        <div className="flex items-center gap-2">
          <RefreshButton queryKeyPrefixes={[['budget-vs-actual'] as const]} tooltip="Refresh budget report" />
          {selectedBudget && (
            <Badge variant="outline">FY {selectedBudget.fiscal_year}</Badge>
          )}
          {/* One currency authority: every figure on this page — plan and
              actual alike — is the company's base currency. */}
          {selectedBudget && baseCurrency && (
            <Badge variant="outline">{baseCurrency}</Badge>
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
                {selectableBudgets.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name} ({b.fiscal_year}) — {b.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      }
    >
      {report && (
        <div className="space-y-6">
          {/* KPI Cards — revenue and cost are never netted into one variance */}
          <div className="stats-grid">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Revenue plan vs earned</CardTitle>
                <Target className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(report.income.actual, baseCurrency)}</div>
                <p className="text-xs text-muted-foreground">
                  Plan {formatCurrency(report.income.budgeted, baseCurrency)}
                </p>
                <p className={cn("text-xs font-medium", report.income.favourable ? "text-green-600" : "text-destructive")}>
                  {report.income.favourable ? "Favourable" : "Unfavourable"}{" "}
                  {formatCurrency(Math.abs(report.income.variance), baseCurrency)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Cost plan vs spent</CardTitle>
                <Target className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(report.expense.actual, baseCurrency)}</div>
                <p className="text-xs text-muted-foreground">
                  Plan {formatCurrency(report.expense.budgeted, baseCurrency)}
                </p>
                <p className={cn("text-xs font-medium", report.expense.favourable ? "text-green-600" : "text-destructive")}>
                  {report.expense.favourable ? "Favourable" : "Unfavourable"}{" "}
                  {formatCurrency(Math.abs(report.expense.variance), baseCurrency)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Net result variance</CardTitle>
                {report.net.favourable ? (
                  <TrendingUp className="h-4 w-4 text-green-600" />
                ) : (
                  <TrendingDown className="h-4 w-4 text-destructive" />
                )}
              </CardHeader>
              <CardContent>
                <div className={cn("text-2xl font-bold", report.net.favourable ? "text-green-600" : "text-destructive")}>
                  {formatCurrency(report.net.variance, baseCurrency)}
                </div>
                <p className="text-xs text-muted-foreground">
                  Actual {formatCurrency(report.net.actual, baseCurrency)} vs plan{" "}
                  {formatCurrency(report.net.budgeted, baseCurrency)}
                </p>
              </CardContent>
            </Card>
          </div>

          {report.unbudgetedRows.length > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {report.unbudgetedRows.length} account/period combination
                {report.unbudgetedRows.length === 1 ? " has" : "s have"} posted activity with no budget line. They are
                included below and marked <span className="font-medium">Unbudgeted</span>.
              </AlertDescription>
            </Alert>
          )}

          {/* Chart */}
          {chartData.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Monthly plan vs actual</CardTitle>
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
                    <Bar dataKey="budgetedIncome" fill="hsl(var(--primary))" name="Revenue plan" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="actualIncome" fill="hsl(var(--accent))" name="Revenue actual" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="budgetedExpense" fill="hsl(var(--muted-foreground))" name="Cost plan" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="actualExpense" fill="hsl(var(--destructive))" name="Cost actual" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Account detail, rendered by the shared reporting engine */}
          <ReportSurface
            title="Budget vs Actual"
            subtitle={selectedBudget ? `${selectedBudget.name} — FY ${selectedBudget.fiscal_year}` : undefined}
            profile="financial"
          >
            {incomeRows.length > 0 && (
              <ReportTable
                columns={columns}
                rows={incomeRows}
                currency={baseCurrency}
                caption="Revenue — favourable when actual exceeds plan"
                emptyMessage="No revenue lines"
              />
            )}
            {expenseRows.length > 0 && (
              <ReportTable
                columns={columns}
                rows={expenseRows}
                currency={baseCurrency}
                caption="Costs — favourable when actual is below plan"
                emptyMessage="No cost lines"
              />
            )}
            {otherRows.length > 0 && (
              <ReportTable
                columns={columns}
                rows={otherRows}
                currency={baseCurrency}
                caption="Other budgeted accounts (not part of the net result)"
                emptyMessage="No other lines"
              />
            )}
            <ReportTable
              columns={columns}
              rows={netRow}
              currency={baseCurrency}
              caption="Net result"
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
