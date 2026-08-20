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

    // Semantic grammar of a cash flow statement (indirect method):
    //   section          → CASH FLOWS FROM <ACTIVITY>
    //   subsection       → "Adjustments for non-cash items"
    //   detail           → the movements themselves
    //   majorTotal       → net cash from each activity
    //   calculatedResult → net increase/(decrease) in cash (derived)
    //   grandTotal       → closing cash, the single final figure
    const activities = [data.operating, data.investing, data.financing];

    activities.forEach((section, sectionIndex) => {
      if (sectionIndex > 0) out.push({ id: `gap-${sectionIndex}`, kind: "spacer" });
      out.push({ id: `sec-${section.label}`, kind: "section", label: section.label });

      const drill = (item: (typeof section.items)[number]) =>
        item.accountIds?.length
          ? () =>
              setDrillDown({
                title: item.label,
                accountId: item.accountIds![0],
                startDate: dateFrom,
                endDate: dateTo,
              })
          : undefined;

      if (section === data.operating && section.items.length > 1) {
        const first = section.items[0];
        out.push({
          id: `${section.label}-0`,
          depth: 1,
          meta: { accountIds: first.accountIds ?? undefined },
          onClick: drill(first),
          values: { item: first.label, amount: first.amount },
        });
        out.push({
          id: `${section.label}-adj-header`,
          kind: "subsection",
          depth: 1,
          label: "Adjustments for non-cash items",
        });
        for (let i = 1; i < section.items.length; i++) {
          const item = section.items[i];
          out.push({
            id: `${section.label}-${i}`,
            depth: 2,
            meta: { accountIds: item.accountIds ?? undefined },
            onClick: drill(item),
            values: { item: item.label, amount: item.amount },
          });
        }
      } else {
        section.items.forEach((item, i) => {
          out.push({
            id: `${section.label}-${i}`,
            depth: 1,
            meta: { accountIds: item.accountIds ?? undefined },
            onClick: drill(item),
            values: { item: item.label, amount: item.amount },
          });
        });
      }

      out.push({
        id: `sub-${section.label}`,
        kind: "majorTotal",
        label: `Net cash from ${section.label.replace(/^Cash Flows from /i, "").toLowerCase()}`,
        values: { amount: section.total },
      });
    });

    out.push({ id: "gap-net", kind: "spacer" });
    out.push({
      id: "net-change",
      kind: "calculatedResult",
      label: "Net increase/(decrease) in cash",
      values: { amount: data.netCashFlow },
    });
    out.push({
      id: "opening-cash",
      values: { item: "Cash and cash equivalents at beginning of period", amount: data.openingCash },
    });
    // IAS 7.28 — FX on cash held is presented separately from operating,
    // investing and financing, as a reconciling item.
    if (Math.abs(data.fxEffect) >= 0.01) {
      out.push({
        id: "fx-effect",
        values: {
          item: "Effect of exchange rate changes on cash held",
          amount: data.fxEffect,
        },
      });
    }
    out.push({
      id: "closing-cash",
      kind: "grandTotal",
      label: "Cash and cash equivalents at end of period",
      values: { amount: data.closingCash },
    });


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
          {/* Reconciliation finding: the statement is built up from postings,
              closing cash is derived independently from ledger balances. If
              the two disagree the difference is shown, never absorbed. */}
          {!data.reconciliation.inBalance && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Statement does not tie to the ledger</AlertTitle>
              <AlertDescription>
                Built-up closing cash is {fmt(data.reconciliation.expectedClosingCash)} but the
                ledger-derived cash balance is {fmt(data.reconciliation.derivedClosingCash)} — an
                unexplained difference of {fmt(data.reconciliation.residual)}. This usually means
                cash movements posted to accounts that are not classified into operating, investing
                or financing.
              </AlertDescription>
            </Alert>
          )}

          {data.needsClassification.length > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>
                {data.needsClassification.length} account
                {data.needsClassification.length === 1 ? "" : "s"} classified by fallback rules
              </AlertTitle>
              <AlertDescription>
                <p className="mb-2">
                  These accounts moved in the period but have no cash-flow category set, so the
                  statement assumed one. Set their category on the chart of accounts to make the
                  presentation explicit.
                </p>
                <ul className="space-y-0.5">
                  {data.needsClassification.slice(0, 8).map((a) => (
                    <li key={a.accountId} className="text-xs">
                      <span className="font-medium">{a.code}</span> {a.name} — assumed{" "}
                      {a.assumedBucket.replace(/_/g, " ")} ({fmt(a.netMovement)})
                    </li>
                  ))}
                  {data.needsClassification.length > 8 && (
                    <li className="text-xs italic">
                      and {data.needsClassification.length - 8} more…
                    </li>
                  )}
                </ul>
              </AlertDescription>
            </Alert>
          )}

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
            profile="operational"
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
