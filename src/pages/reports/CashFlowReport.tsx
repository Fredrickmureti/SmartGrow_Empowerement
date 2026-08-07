/**
 * Cash Flow Statement Page (GL-based, Indirect Method)
 * 
 * Proper cash flow statement derived from journal entries showing:
 * - Operating activities via indirect method (net income + adjustments)
 * - Investing activities (fixed asset changes)
 * - Financing activities (loans + equity)
 * - Opening/closing cash reconciliation
 *
 * Rendered by the canonical reporting engine (`@/design-system/reports`).
 */

import { useState, useCallback, useMemo, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Building2, TrendingUp, CreditCard, ArrowUpRight, ArrowDownRight, Banknote, Wallet } from "lucide-react";
import { format } from "date-fns";
import { useCashFlowReport, type CashFlowSection } from "@/hooks/useCashFlowReport";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { DrillDownDialog, type DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { cn } from "@/lib/utils";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import {
  ReportSurface,
  ReportTable,
  formatAccountingNumber,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
function CashFlowReportInner() {
  const now = new Date();
  const { filters, setDateFrom: setSharedDateFrom, setDateTo: setSharedDateTo } = useReportFilters();
  const [dateFrom, setDateFrom] = useState(filters.dateFrom);
  const [dateTo, setDateTo] = useState(filters.dateTo);
  const [drillDown, setDrillDown] = useState<DrillDownConfig | null>(null);

  useEffect(() => { setSharedDateFrom(dateFrom); }, [dateFrom]);
  useEffect(() => { setSharedDateTo(dateTo); }, [dateTo]);

  const { baseCurrency, isReady } = useCurrency();
  const { currentOrg } = useOrganization();

  const { data, isLoading, error } = useCashFlowReport({ dateFrom, dateTo, branchId: filters.branchId });

  // Standalone figures (KPI cards, banners) use the same accounting
  // policy as the table cells and the exported PDF.
  const fmt = (amount: number) => formatAccountingNumber(amount, baseCurrency);

  // ── One column declaration drives the screen table AND the export ──
  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "item", header: "Item" },
      { key: "amount", header: "Amount", format: "currency", width: "w-[180px]" },
    ],
    [],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    if (!data) return out;

    for (const section of [data.operating, data.investing, data.financing]) {
      out.push({ id: `sec-${section.label}`, kind: "section", label: section.label });

      if (section === data.operating && section.items.length > 1) {
        out.push({
          id: `${section.label}-0`,
          onClick: section.items[0].accountIds?.length
            ? () => setDrillDown({ title: section.items[0].label, accountId: section.items[0].accountIds![0], startDate: dateFrom, endDate: dateTo })
            : undefined,
          values: { item: section.items[0].label, amount: section.items[0].amount },
        });
        out.push({ id: `${section.label}-adj-header`, values: { item: "Adjustments for non-cash items:", amount: null }, depth: 1 });
        for (let i = 1; i < section.items.length; i++) {
          const item = section.items[i];
          out.push({
            id: `${section.label}-${i}`,
            depth: 2,
            onClick: item.accountIds?.length
              ? () => setDrillDown({ title: item.label, accountId: item.accountIds![0], startDate: dateFrom, endDate: dateTo })
              : undefined,
            values: { item: item.label, amount: item.amount },
          });
        }
      } else {
        section.items.forEach((item, i) => {
          out.push({
            id: `${section.label}-${i}`,
            depth: 1,
            onClick: item.accountIds?.length
              ? () => setDrillDown({ title: item.label, accountId: item.accountIds![0], startDate: dateFrom, endDate: dateTo })
              : undefined,
            values: { item: item.label, amount: item.amount },
          });
        });
      }

      out.push({
        id: `sub-${section.label}`,
        kind: "subtotal",
        label: `Net ${section.label.replace("Cash Flows from ", "")}`,
        values: { amount: section.total },
      });
    }

    out.push({ id: "net-change", kind: "grandTotal", label: "Net Increase/(Decrease) in Cash", values: { amount: data.netCashFlow } });
    out.push({ id: "opening-cash", values: { item: "Opening Cash Balance", amount: data.openingCash } });
    out.push({ id: "closing-cash", kind: "grandTotal", label: "Closing Cash Balance", values: { amount: data.closingCash } });

    return out;
  }, [data, dateFrom, dateTo]);

  const getExportConfig = useCallback((): ExportConfig => ({
    title: "Cash Flow Statement",
    reportType: "cash_flow",
    dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
    columns: toExportColumns(columns),
    rows: toExportRows(rows, columns),
    subtitle: "Indirect method",
    sheetName: "Cash Flow",
    currency: baseCurrency,
  }), [columns, rows, dateFrom, dateTo, currentOrg, baseCurrency]);

  return (
    <ReportPageLayout
      title="Cash Flow Statement"
      description="Indirect method — derived from journal entries"
      isLoading={isLoading || !isReady}
      error={error as Error | null}
      isEmpty={!data}
      emptyState={{
        kind: "no_data",
        title: "No cash flow activity for this period",
        message:
          "The indirect-method statement is derived from posted journal entries; none affected cash in the selected period and scope.",
      }}

      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['cash-flow-report'] as const]} tooltip="Refresh cash flow" />
          <SaveViewButton
            reportType="cash-flow"
            currentFilters={{ dateFrom, dateTo }}
            onLoadView={(filters) => {
              if (filters.dateFrom) setDateFrom(filters.dateFrom);
              if (filters.dateTo) setDateTo(filters.dateTo);
            }}
          />
        </>
      }
      filters={
        <ReportFilters
          dateMode="range"
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
        >
          <ReportBranchFilter reportKind="cash_flow" />
        </ReportFilters>
      }
    >
      {data && (
        <div className="space-y-6">
          {/* KPI Cards */}
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <span className="text-sm font-medium">Opening Cash</span>
                <Wallet className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{fmt(data.openingCash)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <span className="text-sm font-medium">Operating</span>
                <Building2 className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className={cn("text-2xl font-bold", data.operating.total >= 0 ? "text-success" : "text-destructive")}>
                  {fmt(data.operating.total)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <span className="text-sm font-medium">Net Cash Flow</span>
                {data.netCashFlow >= 0 ? (
                  <ArrowUpRight className="h-4 w-4 text-success" />
                ) : (
                  <ArrowDownRight className="h-4 w-4 text-destructive" />
                )}
              </CardHeader>
              <CardContent>
                <div className={cn("text-2xl font-bold", data.netCashFlow >= 0 ? "text-success" : "text-destructive")}>
                  {fmt(data.netCashFlow)}
                </div>
              </CardContent>
            </Card>
            <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <span className="text-sm font-medium">Closing Cash</span>
                <Banknote className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-primary">{fmt(data.closingCash)}</div>
              </CardContent>
            </Card>
          </div>

          {/* Statement, rendered by the shared reporting engine */}
          <ReportSurface
            title="Cash Flow Statement"
            dateRange={`${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`}
            subtitle="Indirect method"
            profile="financial"
          >
            <ReportTable
              columns={columns}
              rows={rows}
              currency={baseCurrency}
              caption="Cash flow statement — operating, investing and financing activities"
              emptyMessage="No cash flow activity for this period"
            />
          </ReportSurface>
        </div>
      )}

      {/* M5 FIX: Universal drill-down support */}
      <DrillDownDialog
        open={!!drillDown}
        onOpenChange={(open) => !open && setDrillDown(null)}
        config={drillDown}
      />
    </ReportPageLayout>
  );
}


export default function CashFlowReport() {
  return (
    
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Cash Flow">
      <CashFlowReportInner />
    </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
