/**
 * Purchase Reports — dimensional purchase analysis.
 *
 * ONE report family, many dimensions. Supplier, product, category, expense
 * account, branch and month are grouping keys over the same source rows and
 * the same measure set, so they are a `_dimension` parameter on one engine
 * (`finance_purchase_analysis`), not six report pages.
 *
 * Every figure on this page is produced in SQL, in base currency, from
 * ledger-posted, non-void bills and their vendor credit notes. The page
 * performs NO document arithmetic: no `reduce` over bill totals, no
 * client-side grouping, no re-adding of rows to invent a footer. The GL
 * tie-out banner comes from `finance_purchase_expense_reconciliation`.
 */

import { useCallback, useMemo, useState } from "react";

import { useReportWorkspaceState } from "@/hooks/reports/useReportWorkspaceState";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import {
  usePurchaseAnalysis,
  usePurchaseExpenseReconciliation,
} from "@/hooks/usePurchaseAnalysis";
import {
  PURCHASE_DIMENSIONS,
  PURCHASE_DIMENSION_LABELS,
  isPurchaseDimension,
  type PurchaseDimension,
} from "@/services/finance/purchaseAnalysis";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ReportSurface,
  ReportTable,
  formatAccountingNumber,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { ShoppingBag, RotateCcw, Receipt, Percent } from "lucide-react";
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

function PurchaseReportsInner() {
  const now = new Date();
  const [drillDown, setDrillDown] = useState<{ open: boolean; config: DrillDownConfig | null }>({
    open: false,
    config: null,
  });

  const { filters } = useReportFilters();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { baseCurrency, isReady: currencyReady } = useCurrency();

  // Period and dimension are URL-owned reporting scope, so a drill-down and
  // Back return to exactly the same purchases view.
  const workspace = useReportWorkspaceState();
  const dateFrom = workspace.get(
    "from",
    filters.dateFrom || format(startOfMonth(now), "yyyy-MM-dd"),
  );
  const dateTo = workspace.get("to", filters.dateTo || format(endOfMonth(now), "yyyy-MM-dd"));
  const setDateFrom = (value: string) => workspace.set({ from: value });
  const setDateTo = (value: string) => workspace.set({ to: value });

  const rawDimension = workspace.get("group", "supplier");
  const dimension: PurchaseDimension = isPurchaseDimension(rawDimension)
    ? rawDimension
    : "supplier";
  const setDimension = (value: string) => workspace.set({ group: value });

  const branchId = filters.branchId ?? null;

  const { rows: data, totals, unconvertible, isLoading, error } = usePurchaseAnalysis({
    orgId: currentOrg?.id,
    businessId: currentBusiness?.id ?? null,
    branchId,
    from: dateFrom,
    to: dateTo,
    dimension,
  });

  const { data: reconciliation } = usePurchaseExpenseReconciliation({
    orgId: currentOrg?.id,
    businessId: currentBusiness?.id ?? null,
    branchId,
    from: dateFrom,
    to: dateTo,
  });

  // ── One column declaration drives the screen table AND the export ──
  const columns = useMemo<ReportColumn<ReportRow>[]>(
    () => [
      { key: "label", header: PURCHASE_DIMENSION_LABELS[dimension] },
      { key: "quantity", header: "Qty", format: "number", align: "right", width: "w-[90px]" },
      { key: "gross", header: "Gross", format: "currency", width: "w-[130px]" },
      { key: "discount", header: "Discounts", format: "currency", width: "w-[130px]" },
      { key: "net_purchases", header: "Net purchases", format: "currency", width: "w-[140px]" },
      { key: "returns", header: "Returns", format: "currency", width: "w-[130px]" },
      {
        key: "net_after_returns",
        header: "Net after returns",
        format: "currency",
        width: "w-[150px]",
      },
      { key: "tax", header: "Input tax", format: "currency", width: "w-[130px]" },
      { key: "documents", header: "Docs", format: "number", align: "right", width: "w-[80px]" },
    ],
    [dimension],
  );

  const rows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = (data || []).map((r) => ({
      id: `${dimension}-${r.dimension_key}`,
      // Drill-down exists only where a real relationship does: a supplier row
      // owns bills, so it opens that partner's documents for the period.
      // Product / category / account / branch / month are groupings, not
      // document owners — no drill path is fabricated for them.
      onClick:
        dimension === "supplier" && UUID_RE.test(r.dimension_key)
          ? () =>
              setDrillDown({
                open: true,
                config: {
                  title: `${r.label} — purchase documents`,
                  contactId: r.dimension_key,
                  sourceType: "bill",
                  startDate: dateFrom,
                  endDate: dateTo,
                },
              })
          : undefined,
      values: {
        label: r.label,
        quantity: r.quantity,
        gross: r.gross,
        discount: r.discount,
        net_purchases: r.net_purchases,
        returns: r.returns,
        net_after_returns: r.net_after_returns,
        tax: r.tax,
        documents: r.purchase_documents + r.return_documents,
      },
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
          net_purchases: totals.net_purchases,
          returns: totals.returns,
          net_after_returns: totals.net_after_returns,
          tax: totals.tax,
          documents: totals.purchase_documents + totals.return_documents,
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
      title: `Purchases by ${PURCHASE_DIMENSION_LABELS[dimension]}`,
      reportType: "purchase_analysis",
      companyName: currentOrg?.name || "",
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: toExportColumns(columns),
      rows: toExportRows(rows, columns),
      sheetName: "Purchase Analysis",
      currency: baseCurrency,
    }),
    [columns, rows, dimension, dateFrom, dateTo, currentOrg, baseCurrency],
  );

  const returnsPct =
    totals.net_purchases === 0 ? null : (totals.returns / totals.net_purchases) * 100;

  return (
    <ReportPageLayout
      title="Purchase Reports"
      description="Net purchases, returns and input tax by dimension — base currency, ledger-posted documents only"
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!data || data.length === 0}
      emptyMessage="No posted purchase documents for the selected period"
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton
            queryKeyPrefixes={[
              ["purchase-analysis"] as const,
              ["purchase-expense-reconciliation"] as const,
            ]}
            tooltip="Refresh purchase analysis"
          />
          <SaveViewButton
            reportType="purchases"
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
          <ReportBranchFilter reportKind="purchases" />
          <Select value={dimension} onValueChange={setDimension}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PURCHASE_DIMENSIONS.map((d) => (
                <SelectItem key={d} value={d}>
                  By {PURCHASE_DIMENSION_LABELS[d].toLowerCase()}
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
          {unconvertible.purchase_documents} bill
          {unconvertible.purchase_documents === 1 ? "" : "s"} and{" "}
          {unconvertible.return_documents} vendor credit note
          {unconvertible.return_documents === 1 ? "" : "s"} are in a foreign currency with no
          exchange rate recorded on the document. They are excluded from the figures below
          rather than counted at face value. Record the missing rate to include them.
        </div>
      )}

      {reconciliation && !reconciliation.inBalance && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span className="font-medium">
            Document net purchases do not agree with the general ledger.
          </span>{" "}
          Documents {formatAccountingNumber(reconciliation.documentNetPurchases, baseCurrency)} vs
          ledger {formatAccountingNumber(reconciliation.ledgerNetPurchases, baseCurrency)}{" "}
          (purchase postings{" "}
          {formatAccountingNumber(reconciliation.glPurchaseDebits, baseCurrency)} less returns{" "}
          {formatAccountingNumber(reconciliation.glPurchaseReturns, baseCurrency)}) — variance{" "}
          {formatAccountingNumber(reconciliation.variance, baseCurrency)} for the period.
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
              <CardTitle className="text-sm font-medium">Net purchases</CardTitle>
              <ShoppingBag className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatAccountingNumber(totals.net_purchases, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                {totals.purchase_documents} bills, gross{" "}
                {formatAccountingNumber(totals.gross, baseCurrency)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Returns</CardTitle>
              <RotateCcw className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatAccountingNumber(totals.returns, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                {totals.return_documents} vendor credit notes
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net after returns</CardTitle>
              <Percent className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatAccountingNumber(totals.net_after_returns, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                {returnsPct === null ? "—" : `${returnsPct.toFixed(1)}%`} returned, discounts{" "}
                {formatAccountingNumber(totals.discount, baseCurrency)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Input tax</CardTitle>
              <Receipt className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatAccountingNumber(totals.tax, baseCurrency)}
              </div>
              <p className="text-xs text-muted-foreground">
                On posted purchase documents for the period
              </p>
            </CardContent>
          </Card>
        </div>

        <ReportSurface
          title={`Purchases by ${PURCHASE_DIMENSION_LABELS[dimension].toLowerCase()}`}
          dateRange={`${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`}
          profile="financial"
        >
          <ReportTable
            columns={columns}
            rows={rows}
            currency={baseCurrency}
            caption={`Purchases by ${PURCHASE_DIMENSION_LABELS[dimension].toLowerCase()}, base currency`}
            emptyMessage="No posted purchase documents for the selected period"
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

export default function PurchaseReports() {
  return (
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Purchase reports">
        <PurchaseReportsInner />
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
