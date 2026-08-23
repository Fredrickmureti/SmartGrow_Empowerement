/**
 * Analytic Profit & Loss (Phase 5 — consumer #2)
 *
 * Income and expense of the period broken down by analytic account
 * (cost centre / department / project / product line), sourced from
 * `public.analytic_profit_and_loss`.
 *
 * CONTRACT
 * --------
 * The RPC aggregates only `posted` / `reversed` journal lines that carry an
 * analytic attribution, so this report is a *dimensional view of the GL* — it
 * can never exceed the statutory P&L for the same period, and unattributed
 * postings are legitimately absent (they are visible in the statutory P&L).
 * The browser performs no aggregation: per-analytic subtotals are the rows
 * the server already grouped, and the footer is a presentation roll-up.
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
import { useAnalyticProfitAndLoss } from "@/hooks/finance/useAnalyticReports";
import type {
  ExportColumn,
  ExportConfig,
  ExportRow,
} from "@/services/reports/ReportExportService";

const ALL = "__all__";

function AnalyticProfitAndLossInner() {
  const { filters, setDateFrom, setDateTo } = useReportFilters();
  const { baseCurrency } = useCurrency();
  const { plans = [] } = useAnalyticAccounts();

  const [planId, setPlanId] = useState<string>(ALL);

  const range = { dateFrom: filters.dateFrom, dateTo: filters.dateTo };
  const { data: rows = [], isLoading, error } = useAnalyticProfitAndLoss(
    range,
    planId === ALL ? null : planId,
  );

  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "account", header: "GL account" },
      { key: "income", header: "Income", format: "currency", align: "right" },
      { key: "expense", header: "Expense", format: "currency", align: "right" },
      { key: "margin", header: "Margin", format: "currency", align: "right" },
    ],
    [],
  );

  /**
   * The RPC returns one row per analytic account × GL account, ordered by
   * analytic account. We only insert section headers and per-analytic
   * subtotals — the subtotal is the sum of the server rows in that group,
   * which is a display roll-up of already-aggregated data, never a
   * re-derivation from the subledger.
   */
  const reportRows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    let current: string | null = null;
    let income = 0;
    let expense = 0;

    const pushSubtotal = (label: string) => {
      out.push({
        id: `sub-${label}`,
        kind: "subtotal",
        label: "Analytic margin",
        values: {
          account: null,
          income,
          expense,
          margin: income - expense,
        },
      });
    };

    rows.forEach((r, idx) => {
      if (r.analytic_account_id !== current) {
        if (current !== null) pushSubtotal(current);
        current = r.analytic_account_id;
        income = 0;
        expense = 0;
        out.push({
          id: `hdr-${r.analytic_account_id}`,
          kind: "section",
          label: `${r.analytic_code ? `${r.analytic_code} · ` : ""}${r.analytic_name} (${r.plan_name})`,
          values: {},
        });
      }
      income += r.income;
      expense += r.expense;
      out.push({
        id: `${r.analytic_account_id}-${r.account_id}-${idx}`,
        kind: "detail",
        values: {
          account: [r.account_code, r.account_name].filter(Boolean).join(" · "),
          income: r.income,
          expense: r.expense,
          margin: r.margin,
        },
      });
      if (idx === rows.length - 1 && current !== null) pushSubtotal(current);
    });

    if (rows.length > 0) {
      const totalIncome = rows.reduce((s, r) => s + r.income, 0);
      const totalExpense = rows.reduce((s, r) => s + r.expense, 0);
      out.push({
        id: "grand-total",
        kind: "grandTotal",
        label: "Total attributed",
        values: {
          account: null,
          income: totalIncome,
          expense: totalExpense,
          margin: totalIncome - totalExpense,
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
      { key: "income", header: "Income", width: 16, format: "currency", align: "right" },
      { key: "expense", header: "Expense", width: 16, format: "currency", align: "right" },
      { key: "margin", header: "Margin", width: 16, format: "currency", align: "right" },
    ];
    const exportRows: ExportRow[] = rows.map((r) => ({
      analytic: `${r.analytic_code ? `${r.analytic_code} · ` : ""}${r.analytic_name}`,
      plan: r.plan_name,
      account: [r.account_code, r.account_name].filter(Boolean).join(" · "),
      income: r.income,
      expense: r.expense,
      margin: r.margin,
    }));
    return {
      title: "Analytic Profit & Loss",
      subtitle: `${filters.dateFrom} → ${filters.dateTo}`,
      columns: exportColumns,
      rows: exportRows,
      currency: baseCurrency,
    };
  }, [rows, filters.dateFrom, filters.dateTo, baseCurrency]);

  return (
    <ReportPageLayout
      title="Analytic Profit & Loss"
      description="Income and expense of the period per cost centre, department, project or product line. Only posted journal lines carrying an analytic account are included, so this is a dimensional view of the General Ledger — never a second book."
      isLoading={isLoading}
      error={(error as Error) ?? null}
      isEmpty={!isLoading && rows.length === 0}
      emptyMessage="No attributed income or expense in this period. Tag documents with an analytic account and post them."
      getExportConfig={getExportConfig}
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="apl-from" className="text-xs">From</Label>
            <Input
              id="apl-from"
              type="date"
              className="w-[160px]"
              value={filters.dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="apl-to" className="text-xs">To</Label>
            <Input
              id="apl-to"
              type="date"
              className="w-[160px]"
              value={filters.dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
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
        title="Analytic Profit & Loss"
        subtitle={`${filters.dateFrom} → ${filters.dateTo} · ${rows.length} attributed account line(s)`}
        profile="financial"
      >
        <ReportTable
          columns={columns}
          rows={reportRows}
          currency={baseCurrency}
          caption="Posted income and expense grouped by analytic account"
          emptyMessage="No attributed income or expense in the selected period"
        />
      </ReportSurface>
    </ReportPageLayout>
  );
}

export default function AnalyticProfitAndLoss() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Analytic profit & loss">
        <AnalyticProfitAndLossInner />
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
