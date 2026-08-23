/**
 * Analytic Budget vs Actual (Phase 5 — consumer #3)
 *
 * Compares budget lines planned against an analytic dimension with the actual
 * analytic movement of the General Ledger, via
 * `public.analytic_budget_vs_actual`.
 *
 * CONTRACT
 * --------
 * Budget lines carry `analytic_account_id` (cost centre / department /
 * project / product line); actuals come from posted journal lines carrying
 * the same attribution. Variance and variance % are computed server-side by
 * account nature (favourable-positive), so the browser never re-derives a
 * sign. Rows with a budget but no movement, and movement with no budget, both
 * appear — an unplanned cost is exactly what this report exists to surface.
 */

import { useCallback, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { ReportFilterProvider, useReportFilters } from "@/contexts/ReportFilterContext";
import {
  ReportSurface,
  ReportTable,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { useCurrency } from "@/hooks/useCurrency";
import { useAnalyticAccounts } from "@/hooks/useAnalyticAccounts";
import { useBudgets } from "@/hooks/useBudgets";
import { useAnalyticBudgetVsActual } from "@/hooks/finance/useAnalyticReports";
import type {
  ExportColumn,
  ExportConfig,
  ExportRow,
} from "@/services/reports/ReportExportService";

const ALL = "__all__";

function AnalyticBudgetVsActualInner() {
  const { filters, setDateFrom, setDateTo } = useReportFilters();
  const { baseCurrency } = useCurrency();
  const { plans = [] } = useAnalyticAccounts();
  const { budgets = [] } = useBudgets();

  const [planId, setPlanId] = useState<string>(ALL);
  const [budgetId, setBudgetId] = useState<string>(ALL);

  const range = { dateFrom: filters.dateFrom, dateTo: filters.dateTo };
  const { data: rows = [], isLoading, error } = useAnalyticBudgetVsActual(
    range,
    budgetId === ALL ? null : budgetId,
    planId === ALL ? null : planId,
  );

  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "account", header: "GL account" },
      { key: "budgeted", header: "Budgeted", format: "currency", align: "right" },
      { key: "actual", header: "Actual", format: "currency", align: "right" },
      { key: "variance", header: "Variance", format: "currency", align: "right" },
      { key: "variance_pct", header: "Variance %", format: "percent", align: "right" },
    ],
    [],
  );

  /**
   * Grouped per analytic account. Subtotals roll up the server rows of the
   * group; the variance subtotal is budgeted − actual on the already
   * sign-normalised figures, so it stays consistent with each line.
   */
  const reportRows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    let current: string | null = null;
    let budgeted = 0;
    let actual = 0;
    let variance = 0;

    const pushSubtotal = (key: string) => {
      out.push({
        id: `sub-${key}`,
        kind: "subtotal",
        label: "Analytic total",
        values: {
          account: null,
          budgeted,
          actual,
          variance,
          variance_pct: budgeted === 0 ? null : (variance / Math.abs(budgeted)) * 100,
        },
      });
    };

    rows.forEach((r, idx) => {
      if (r.analytic_account_id !== current) {
        if (current !== null) pushSubtotal(current);
        current = r.analytic_account_id;
        budgeted = 0;
        actual = 0;
        variance = 0;
        out.push({
          id: `hdr-${r.analytic_account_id}`,
          kind: "section",
          label: `${r.analytic_code ? `${r.analytic_code} · ` : ""}${r.analytic_name} (${r.plan_name})`,
          values: {},
        });
      }
      budgeted += r.budgeted;
      actual += r.actual;
      variance += r.variance;
      out.push({
        id: `${r.analytic_account_id}-${r.account_id}-${idx}`,
        kind: "detail",
        values: {
          account: [r.account_code, r.account_name].filter(Boolean).join(" · "),
          budgeted: r.budgeted,
          actual: r.actual,
          variance: r.variance,
          variance_pct: r.variance_pct,
        },
      });
      if (idx === rows.length - 1 && current !== null) pushSubtotal(current);
    });

    if (rows.length > 0) {
      const totalBudget = rows.reduce((s, r) => s + r.budgeted, 0);
      const totalActual = rows.reduce((s, r) => s + r.actual, 0);
      const totalVariance = rows.reduce((s, r) => s + r.variance, 0);
      out.push({
        id: "grand-total",
        kind: "grandTotal",
        label: "Total",
        values: {
          account: null,
          budgeted: totalBudget,
          actual: totalActual,
          variance: totalVariance,
          variance_pct:
            totalBudget === 0 ? null : (totalVariance / Math.abs(totalBudget)) * 100,
        },
      });
    }
    return out;
  }, [rows]);

  const getExportConfig = useCallback((): ExportConfig => {
    const exportColumns: ExportColumn[] = [
      { key: "analytic", header: "Analytic account", width: 32 },
      { key: "plan", header: "Plan", width: 20 },
      { key: "account", header: "GL account", width: 32 },
      { key: "budgeted", header: "Budgeted", width: 16, format: "currency", align: "right" },
      { key: "actual", header: "Actual", width: 16, format: "currency", align: "right" },
      { key: "variance", header: "Variance", width: 16, format: "currency", align: "right" },
      { key: "variance_pct", header: "Variance %", width: 14, align: "right" },
    ];
    const exportRows: ExportRow[] = rows.map((r) => ({
      analytic: `${r.analytic_code ? `${r.analytic_code} · ` : ""}${r.analytic_name}`,
      plan: r.plan_name,
      account: [r.account_code, r.account_name].filter(Boolean).join(" · "),
      budgeted: r.budgeted,
      actual: r.actual,
      variance: r.variance,
      variance_pct: r.variance_pct,
    }));
    return {
      title: "Analytic Budget vs Actual",
      subtitle: `${filters.dateFrom} → ${filters.dateTo}`,
      columns: exportColumns,
      rows: exportRows,
      currency: baseCurrency,
    };
  }, [rows, filters.dateFrom, filters.dateTo, baseCurrency]);

  return (
    <ReportPageLayout
      title="Analytic Budget vs Actual"
      description="Plan versus posted reality per cost centre, department, project or product line. Variance is favourable-positive and computed by account nature in the database."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="Nothing to compare yet. Plan budget lines against an analytic account, or post documents carrying one."
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="abva-from" className="text-xs">From</Label>
            <Input
              id="abva-from"
              type="date"
              className="w-[160px]"
              value={filters.dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="abva-to" className="text-xs">To</Label>
            <Input
              id="abva-to"
              type="date"
              className="w-[160px]"
              value={filters.dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Budget</Label>
            <Select value={budgetId} onValueChange={setBudgetId}>
              <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All budgets</SelectItem>
                {budgets.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name} ({b.fiscal_year})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Analytic plan</Label>
            <Select value={planId} onValueChange={setPlanId}>
              <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All plans</SelectItem>
                {plans.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      }
    >
      <ReportSurface
        title="Analytic Budget vs Actual"
        subtitle={`${filters.dateFrom} → ${filters.dateTo} · ${rows.length} comparison line(s)`}
        profile="financial"
      >
        <ReportTable
          columns={columns}
          rows={reportRows}
          currency={baseCurrency}
          caption="Budgeted versus posted actuals per analytic account"
          emptyMessage="No budget or actual movement for the selected filters"
        />
      </ReportSurface>
    </ReportPageLayout>
  );
}

export default function AnalyticBudgetVsActual() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Analytic budget vs actual">
        <AnalyticBudgetVsActualInner />
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
