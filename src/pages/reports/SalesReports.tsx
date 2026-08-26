/**
 * Sales Reports — dimensional sales analysis.
 *
 * ONE report family, many dimensions. Customer, product, category, branch,
 * salesperson and month are grouping keys over the same source rows and the
 * same measure set, so they are a `_dimension` parameter on one engine
 * (`finance_sales_analysis`), not five report pages.
 *
 * Every figure on this page is produced in SQL, in base currency, from
 * ledger-posted, non-void invoices and their credit notes. The page performs
 * NO invoice arithmetic: no `reduce` over document totals, no client-side
 * grouping, no re-adding of rows to invent a footer. The GL tie-out banner
 * comes from `finance_sales_revenue_reconciliation`.
 */

import { useCallback, useMemo, useState } from "react";

import { useReportWorkspaceState } from "@/hooks/reports/useReportWorkspaceState";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import {
  useSalesAnalysis,
  useSalesRevenueReconciliation,
} from "@/hooks/useSalesAnalysis";
import {
  SALES_DIMENSIONS,
  SALES_DIMENSION_LABELS,
  isSalesDimension,
  
  type SalesDimension,
} from "@/services/finance/salesAnalysis";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ReportSurface,
  ReportTable,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { ShoppingCart, TrendingUp, Receipt, Percent } from "lucide-react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { DrillDownDialog, type DrillDownConfig } from "@/components/reports/DrillDownDialog";

/** Only a real contact id can open a partner drill-down. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function SalesReportsInner() {
  const now = new Date();
  const [drillDown, setDrillDown] = useState<{ open: boolean; config: DrillDownConfig | null }>({
    open: false,
    config: null,
  });

  const { filters } = useReportFilters();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  // Period and dimension are URL-owned reporting scope, so a drill-down and
  // Back return to exactly the same sales view.
  const workspace = useReportWorkspaceState();
  const dateFrom = workspace.get(
    "from",
    filters.dateFrom || format(startOfMonth(now), "yyyy-MM-dd"),
  );
  const dateTo = workspace.get("to", filters.dateTo || format(endOfMonth(now), "yyyy-MM-dd"));
  const setDateFrom = (value: string) => workspace.set({ from: value });
  const setDateTo = (value: string) => workspace.set({ to: value });

  const rawDimension = workspace.get("group", "customer");
  const dimension: SalesDimension = isSalesDimension(rawDimension) ? rawDimension : "customer";
  const setDimension = (value: string) => workspace.set({ group: value });

  const branchId = filters.branchId ?? null;

  const { rows: data, totals, unconvertible, isLoading, error } = useSalesAnalysis({
    orgId: currentOrg?.id,
    businessId: currentBusiness?.id ?? null,
    branchId,
    from: dateFrom,
    to: dateTo,
    dimension,
  });

  const { data: reconciliation } = useSalesRevenueReconciliation({
    orgId: currentOrg?.id,
    businessId: currentBusiness?.id ?? null,
    branchId,
    from: dateFrom,
    to: dateTo,
  });

  // ── One column declaration drives the screen table AND the export ──
  const columns = useMemo<ReportColumn<ReportRow>[]>(
    () => [
      { key: "label", header: SALES_DIMENSION_LABELS[dimension] },
      { key: "quantity", header: "Qty", format: "number", align: "right", width: "w-[90px]" },
      { key: "gross", header: "Gross", format: "currency", width: "w-[130px]" },
      { key: "discount", header: "Discounts", format: "currency", width: "w-[130px]" },
      { key: "net_sales", header: "Net sales", format: "currency", width: "w-[130px]" },
      { key: "returns", header: "Returns", format: "currency", width: "w-[130px]" },
      {
        key: "net_after_returns",
        header: "Net after returns",
        format: "currency",
        width: "w-[150px]",
      },
      { key: "tax", header: "Tax", format: "currency", width: "w-[120px]" },
      { key: "cost", header: "Cost", format: "currency", width: "w-[130px]" },
      { key: "margin", header: "Margin", format: "currency", width: "w-[130px]" },
      { key: "margin_pct", header: "Margin %", format: "percent", align: "right", width: "w-[100px]" },
      { key: "documents", header: "Docs", format: "number", align: "right", width: "w-[80px]" },
    ],
    [dimension],
  );

  const toValues = (row: {
    label: string;
    quantity: number;
    gross: number;
    discount: number;
    net_sales: number;
    returns: number;
    net_after_returns: number;
    tax: number;
    cost: number;
    margin: number;
    margin_pct: number | null;
    sale_documents: number;
    return_documents: number;
  }) => ({
    label: row.label,
    quantity: row.quantity,
    gross: row.gross,
    discount: row.discount,
    net_sales: row.net_sales,
    returns: row.returns,
    net_after_returns: row.net_after_returns,
    tax: row.tax,
    cost: row.cost,
    margin: row.margin,
    margin_pct: row.margin_pct,
    documents: row.sale_documents + row.return_documents,
  });

  const rows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = (data || []).map((r) => ({
      id: `${dimension}-${r.dimension_key}`,
      // Drill-down exists only where a real relationship does: a customer row
      // owns invoices, so it opens that partner's documents for the period.
      // Product / category / branch / salesperson / month are groupings, not
      // document owners — no drill path is fabricated for them.
      onClick:
        dimension === "customer" && UUID_RE.test(r.dimension_key)
          ? () =>
              setDrillDown({
                open: true,
                config: {
                  title: `${r.label} — sales documents`,
                  contactId: r.dimension_key,
                  sourceType: "invoice",
                  startDate: dateFrom,
                  endDate: dateTo,
                },
              })
          : undefined,
      values: toValues(r),
    }));


    if (out.length > 0) {
      // The footer is the engine's totals envelope — never a sum of the rows
      // on screen, which would be wrong the moment the result set is paged.
      out.push({
        id: "grand-total",
        kind: "grandTotal",
        label: "TOTAL",
        values: {
          label: "TOTAL",
          quantity: totals.quantity,
          gross: totals.gross,
          discount: totals.discount,
          net_sales: totals.net_sales,
          returns: totals.returns,
          net_after_returns: totals.net_after_returns,
          tax: totals.tax,
          cost: totals.cost,
          margin: totals.margin,
          margin_pct:
            totals.net_after_returns === 0
              ? null
              : (totals.margin / totals.net_after_returns) * 100,
          documents: totals.sale_documents + totals.return_documents,
        },
      });
    }
    return out;
  }, [data, totals, dimension, dateFrom, dateTo]);

  // The engine is queried unpaged (`limit: null`), so `rows` already IS the
  // whole report — the export renders the same dataset through the same column
  // declaration and never re-aggregates anything.
  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: `Sales by ${SALES_DIMENSION_LABELS[dimension]}`,
      reportType: "sales_analysis",
      companyName: currentOrg?.name || "",
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: toExportColumns(columns),
      rows: toExportRows(rows, columns),
      sheetName: "Sales Analysis",
      currency: baseCurrency,
    }),
    [columns, rows, dimension, dateFrom, dateTo, currentOrg, baseCurrency],
  );


  const marginPct =
    totals.net_after_returns === 0 ? null : (totals.margin / totals.net_after_returns) * 100;

  return (
    <ReportPageLayout
      title="Sales Reports"
      description="Net sales, returns and margin by dimension — base currency, ledger-posted documents only"
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!data || data.length === 0}
      emptyMessage="No posted sales documents for the selected period"
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton
            queryKeyPrefixes={[["sales-analysis"] as const, ["sales-revenue-reconciliation"] as const]}
            tooltip="Refresh sales analysis"
          />
          <SaveViewButton
            reportType="sales"
            currentFilters={{ dimension, dateFrom, dateTo }}
            onLoadView={(saved) => {
              if (saved.dimension) setDimension(saved.dimension);
              if (saved.dateFrom) setDateFrom(saved.dateFrom);
              if (saved.dateTo) setDateTo(saved.dateTo);
            }}
          />
        </>
      }
      filters={
        <ReportFilters
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
        >
          <ReportBranchFilter reportKind="sales" />
          <Select value={dimension} onValueChange={setDimension}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SALES_DIMENSIONS.map((d) => (
                <SelectItem key={d} value={d}>
                  By {SALES_DIMENSION_LABELS[d].toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ReportFilters>
      }
    >
      {unconvertible.total > 0 && (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <span className="font-medium">
            {unconvertible.total} document{unconvertible.total === 1 ? "" : "s"} could not be
            valued in {baseCurrency}.
          </span>{" "}
          {unconvertible.sale_documents} invoice
          {unconvertible.sale_documents === 1 ? "" : "s"} and {unconvertible.return_documents}{" "}
          credit note{unconvertible.return_documents === 1 ? "" : "s"} are in a foreign currency
          with no exchange rate recorded on the document. They are excluded from the figures
          below rather than counted at face value. Record the missing rate to include them.
        </div>
      )}

      {reconciliation && !reconciliation.inBalance && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span className="font-medium">
            Document net sales do not agree with the general ledger.
          </span>{" "}
          Documents {formatCurrency(reconciliation.documentNetSales, baseCurrency)} vs ledger{" "}
          {formatCurrency(reconciliation.ledgerNetSales, baseCurrency)} (revenue{" "}
          {formatCurrency(reconciliation.glRevenue, baseCurrency)} less returns{" "}
          {formatCurrency(reconciliation.glSalesReturns, baseCurrency)} and discounts{" "}
          {formatCurrency(reconciliation.glDiscountsGiven, baseCurrency)}) — variance{" "}
          {formatCurrency(reconciliation.variance, baseCurrency)} for the period.
          {reconciliation.unconvertibleDocumentCount > 0 && (
            <>
              {" "}
              {reconciliation.unconvertibleDocumentCount} document
              {reconciliation.unconvertibleDocumentCount === 1 ? " is" : "s are"} excluded from
              the document side for want of an exchange rate, so this period cannot tie out
              until the missing rates are recorded.
            </>
          )}
        </div>
      )}

      <div className="space-y-6">
        <div className="stats-grid">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net sales</CardTitle>
              <ShoppingCart className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totals.net_sales, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                {totals.sale_documents} invoices, gross{" "}
                {formatCurrency(totals.gross, baseCurrency)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Returns</CardTitle>
              <Receipt className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totals.returns, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                {totals.return_documents} credit notes
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net after returns</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totals.net_after_returns, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                Discounts {formatCurrency(totals.discount, baseCurrency)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Margin</CardTitle>
              <Percent className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatCurrency(totals.margin, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                {marginPct === null ? "—" : `${marginPct.toFixed(1)}%`} of net after returns
              </p>
            </CardContent>
          </Card>
        </div>

        <ReportSurface
          title={`Sales by ${SALES_DIMENSION_LABELS[dimension].toLowerCase()}`}
          dateRange={`${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`}
          profile="financial"
        >
          <ReportTable
            columns={columns}
            rows={rows}
            currency={baseCurrency}
            caption={`Sales by ${SALES_DIMENSION_LABELS[dimension].toLowerCase()}, base currency`}
            emptyMessage="No posted sales documents for the selected period"
          />
        </ReportSurface>
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
