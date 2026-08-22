/**
 * Financial Reports Page
 * 
 * Enterprise-grade P&L, Balance Sheet, and Cash Flow statements
 * powered by the journal-entry-based financial report engine.
 * All data comes from posted journal entries (accrual basis).
 * 
 * Implements IAS 1 / IFRS compliant presentation:
 * - Balance Sheet: Current/Non-Current sub-classification
 * - P&L: Multi-step format (Revenue → COGS → Gross Profit → OpEx → Net Income)
 *
 * Rendered by the canonical reporting engine (`@/design-system/reports`):
 * each statement declares columns + typed rows, the engine owns alignment,
 * hierarchy, sticky headers, formatting and PDF parity.
 */

import { useState, useCallback, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DollarSign, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight, AlertTriangle, ExternalLink } from "lucide-react";
import { format, startOfYear, endOfMonth, subYears, startOfMonth, startOfQuarter, endOfQuarter, endOfYear } from "date-fns";
import { useFinancialReport, type FinancialReportAccount } from "@/hooks/useFinancialReport";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useInvoiceIntegrityCheck } from "@/hooks/useInvoiceValidation";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { DrillDownDialog, type DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { PeriodLockBanner } from "@/components/reports/PeriodLockBanner";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { useNavigate } from "react-router-dom";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import {
  classifyAccount,
  groupBySubType,
  SUB_TYPE_LABELS,
  BS_ASSET_ORDER,
  BS_LIABILITY_ORDER,
  type AccountSubType,
  type ClassifiedAccount,
} from "@/services/reports/AccountClassification";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import {
  ReportSurface,
  ReportTable,
  formatAccountingNumber,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";
import { cn } from "@/lib/utils";

type ComparisonMode = "none" | "previous_period" | "same_period_last_year";

function getComparisonDates(mode: ComparisonMode, dateFrom: string, dateTo: string) {
  if (mode === "none") return { from: undefined, to: undefined, label: "" };

  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  const durationMs = to.getTime() - from.getTime();

  if (mode === "previous_period") {
    const prevTo = new Date(from.getTime() - 86400000);
    const prevFrom = new Date(prevTo.getTime() - durationMs);
    return {
      from: format(prevFrom, "yyyy-MM-dd"),
      to: format(prevTo, "yyyy-MM-dd"),
      label: `${format(prevFrom, "MMM d")} – ${format(prevTo, "MMM d, yyyy")}`,
    };
  }

  const prevFrom = subYears(from, 1);
  const prevTo = subYears(to, 1);
  return {
    from: format(prevFrom, "yyyy-MM-dd"),
    to: format(prevTo, "yyyy-MM-dd"),
    label: `${format(prevFrom, "MMM d")} – ${format(prevTo, "MMM d, yyyy")}`,
  };
}

/** Classify report accounts with sub-types using detail_type as primary source */
function classifyAccounts(accounts: FinancialReportAccount[]): ClassifiedAccount[] {
  return accounts
    .filter(a => !a.is_group)
    .map(a => ({
      ...a,
      sub_type: classifyAccount(a.account_type, a.code, a.detail_type),
    }));
}

function FinancialReportsInner() {
  const now = new Date();
  const { filters, setDateFrom: setSharedDateFrom, setDateTo: setSharedDateTo, setComparisonMode: setSharedComparisonMode } = useReportFilters();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Deep-link support: ?view=pnl | balance_sheet | bs (also accepts legacy ?report=)
  const initialView = (() => {
    const raw = (searchParams.get("view") || searchParams.get("report") || "pnl").toLowerCase();
    if (raw === "bs" || raw === "balance-sheet" || raw === "balance_sheet") return "balance_sheet";
    return "pnl";
  })();
  const [activeTab, setActiveTab] = useState(initialView);

  // Deep-link convention shared with the main Dashboard KPI cards:
  // ?period=current_month | current_quarter | ytd | current_year | last_year
  // resolves to a (from, to) date pair the existing P&L / BS engines use.
  // Unknown / missing values fall through to the shared ReportFilters
  // context defaults so this is non-breaking for non-deep-link entries.
  const periodFromQuery = ((): { from: string; to: string } | null => {
    const raw = (searchParams.get("period") || "").toLowerCase();
    if (!raw) return null;
    const now = new Date();
    const fmt = (d: Date) => format(d, "yyyy-MM-dd");
    if (raw === "current_month" || raw === "this_month" || raw === "month") {
      return { from: fmt(startOfMonth(now)), to: fmt(endOfMonth(now)) };
    }
    if (raw === "current_quarter" || raw === "quarter") {
      return { from: fmt(startOfQuarter(now)), to: fmt(endOfQuarter(now)) };
    }
    if (raw === "ytd" || raw === "current_year" || raw === "year") {
      return { from: fmt(startOfYear(now)), to: fmt(endOfYear(now)) };
    }
    if (raw === "last_year" || raw === "previous_year") {
      const prev = subYears(now, 1);
      return { from: fmt(startOfYear(prev)), to: fmt(endOfYear(prev)) };
    }
    return null;
  })();
  const [dateFrom, setDateFrom] = useState(periodFromQuery?.from ?? filters.dateFrom);
  const [dateTo, setDateTo] = useState(periodFromQuery?.to ?? filters.dateTo);
  const [drillDown, setDrillDown] = useState<DrillDownConfig | null>(null);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>(filters.comparisonMode as ComparisonMode || "none");

  // React to URL changes (palette navigation while page is mounted).
  useEffect(() => {
    const raw = (searchParams.get("view") || searchParams.get("report") || "").toLowerCase();
    if (!raw) return;
    if (raw === "bs" || raw === "balance-sheet" || raw === "balance_sheet") setActiveTab("balance_sheet");
    else if (raw === "pnl" || raw === "p&l" || raw === "profit-loss") setActiveTab("pnl");
  }, [searchParams]);

  // Honor late-arriving ?period= changes (in-app navigation while mounted).
  useEffect(() => {
    const raw = (searchParams.get("period") || "").toLowerCase();
    if (!raw) return;
    const now = new Date();
    const fmt = (d: Date) => format(d, "yyyy-MM-dd");
    let next: { from: string; to: string } | null = null;
    if (raw === "current_month" || raw === "this_month" || raw === "month") {
      next = { from: fmt(startOfMonth(now)), to: fmt(endOfMonth(now)) };
    } else if (raw === "current_quarter" || raw === "quarter") {
      next = { from: fmt(startOfQuarter(now)), to: fmt(endOfQuarter(now)) };
    } else if (raw === "ytd" || raw === "current_year" || raw === "year") {
      next = { from: fmt(startOfYear(now)), to: fmt(endOfYear(now)) };
    } else if (raw === "last_year" || raw === "previous_year") {
      const prev = subYears(now, 1);
      next = { from: fmt(startOfYear(prev)), to: fmt(endOfYear(prev)) };
    }
    if (next) {
      setDateFrom(next.from);
      setDateTo(next.to);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Sync local state changes back to shared context
  useEffect(() => { setSharedDateFrom(dateFrom); }, [dateFrom]);
  useEffect(() => { setSharedDateTo(dateTo); }, [dateTo]);
  useEffect(() => { setSharedComparisonMode(comparisonMode); }, [comparisonMode]);

  const { baseCurrency, isReady: currencyReady } = useCurrency();
  const { currentOrg } = useOrganization();
  const { data: integrityReport } = useInvoiceIntegrityCheck();

  const comparison = getComparisonDates(comparisonMode, dateFrom, dateTo);
  const showComparison = comparisonMode !== "none";

  const { data: pnlData, isLoading: pnlLoading, error: pnlError } = useFinancialReport({
    reportType: "pnl",
    dateFrom,
    dateTo,
    comparisonDateFrom: comparison.from,
    comparisonDateTo: comparison.to,
    branchId: filters.branchId,
  });

  const { data: bsData, isLoading: bsLoading, error: bsError } = useFinancialReport({
    reportType: "balance_sheet",
    dateFrom: "1970-01-01",
    dateTo,
    comparisonDateFrom: comparison.from ? "1970-01-01" : undefined,
    comparisonDateTo: comparison.to,
    // Wave 5: Balance Sheet is an entity-level statement. Never split by
    // branch — assets/liabilities/equity belong to the legal entity.
    branchId: null,
  });

  const isLoading = (activeTab === "pnl" ? pnlLoading : bsLoading) || !currencyReady;
  const error = activeTab === "pnl" ? pnlError : bsError;

  const handleDrillDown = (account: { id: string; code: string; name: string }) => {
    // Balance Sheet is "as-of" — closing balance includes ALL prior movements.
    // P&L is period-bounded. Use the same startDate semantics here as the engine
    // uses to compute the displayed number, otherwise the drill total will not
    // reconcile with the BS line.
    //
    // The tab value is "balance_sheet" (see <TabsTrigger>); comparing against
    // "bs" silently made every Balance Sheet drill-down period-bounded, so the
    // listed journals could never add up to the cumulative balance shown.
    const isBalanceSheet = activeTab === "balance_sheet";
    setDrillDown({
      title: `${account.code} - ${account.name}`,
      accountId: account.id,
      startDate: isBalanceSheet ? "1970-01-01" : dateFrom,
      endDate: dateTo,
    });
  };


  /** Navigate to General Ledger filtered to a specific account */
  const handleViewInGL = (account: { id: string }) => {
    navigate(`/finance/reports/general-ledger?account_id=${account.id}&date_from=${dateFrom}&date_to=${dateTo}`);
  };

  // Standalone figures (KPI cards, banners) use the same accounting
  // policy as the table cells and the exported PDF.
  const fmt = (amount: number) => formatAccountingNumber(amount, baseCurrency);

  // ─── Classified accounts for sub-type grouping ───
  const classifiedBsAccounts = useMemo(() => {
    if (!bsData) return [];
    const all = [
      ...(bsData.sections["asset"] || []),
      ...(bsData.sections["liability"] || []),
      ...(bsData.sections["equity"] || []),
    ];
    return classifyAccounts(all);
  }, [bsData]);

  const classifiedPnlAccounts = useMemo(() => {
    if (!pnlData) return [];
    const all = [
      ...(pnlData.sections["income"] || []),
      ...(pnlData.sections["expense"] || []),
    ];
    return classifyAccounts(all);
  }, [pnlData]);

  // ─── P&L sub-type totals ───
  const pnlSubTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const acct of classifiedPnlAccounts) {
      totals[acct.sub_type] = (totals[acct.sub_type] || 0) + acct.display_amount;
    }
    return totals;
  }, [classifiedPnlAccounts]);

  const totalRevenue = pnlSubTotals["revenue"] || 0;
  const totalCOGS = pnlSubTotals["cost_of_sales"] || 0;
  const grossProfit = totalRevenue - totalCOGS;
  const totalOpEx = pnlSubTotals["operating_expense"] || 0;
  const operatingProfit = grossProfit - totalOpEx;
  const totalOtherIncome = pnlSubTotals["other_income"] || 0;
  const totalOtherExpense = pnlSubTotals["other_expense"] || 0;
  const totalTaxExpense = pnlSubTotals["tax_expense"] || 0;
  const netIncomeBeforeTax = operatingProfit + totalOtherIncome - totalOtherExpense;
  const netIncome = netIncomeBeforeTax - totalTaxExpense;

  // ─── P&L columns + rows (single declaration drives screen + export) ───
  const pnlColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "name", header: "Account" },
      { key: "amount", header: "Amount", format: "currency", width: "w-[160px]" },
      ...(showComparison
        ? ([
            { key: "comparison", header: comparison.label || "Previous", format: "currency", width: "w-[140px]" },
            { key: "variance", header: "Variance", format: "currency", width: "w-[120px]" },
            { key: "variance_pct", header: "%", format: "percent", width: "w-[80px]" },
          ] as ReportColumn[])
        : []),
    ],
    [showComparison, comparison.label],
  );

  const pnlRows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    const grouped = groupBySubType(classifiedPnlAccounts);

    const pushSubSection = (subType: AccountSubType) => {
      const accts = grouped.get(subType) || [];
      if (accts.length === 0) return;
      out.push({ id: `sec-${subType}`, kind: "section", label: SUB_TYPE_LABELS[subType] });
      for (const acct of accts) {
        out.push({
          id: acct.id,
          depth: 1,
          meta: { accountId: acct.id },
          onClick: () => handleDrillDown(acct),
          values: {
            name: acct.name,
            amount: acct.display_amount,
            comparison: acct.comparison_amount ?? null,
            variance: acct.variance ?? null,
            variance_pct: acct.variance_percent ?? null,
          },
        });
      }
      const subTotal = accts.reduce((s, a) => s + a.display_amount, 0);
      out.push({
        id: `sub-${subType}`,
        kind: "subtotal",
        label: `Total ${SUB_TYPE_LABELS[subType]}`,
        values: { amount: subTotal },
      });
    };

    // Semantic grammar of an income statement: sub-section SUBTOTALS sum
    // accounts, CALCULATED RESULTS are derived figures (gross profit is not
    // a sum of anything), and there is exactly ONE grand total — the net
    // result. Previously every one of these was a "grand total", which is
    // why the PDF showed three identical double-ruled bands.
    pushSubSection("revenue");
    pushSubSection("cost_of_sales");
    out.push({ id: "gross-profit", kind: "calculatedResult", label: "Gross profit", values: { amount: grossProfit } });

    pushSubSection("operating_expense");
    out.push({ id: "operating-profit", kind: "calculatedResult", label: "Operating profit", values: { amount: operatingProfit } });

    pushSubSection("other_income");
    pushSubSection("other_expense");

    if (totalOtherIncome > 0 || totalOtherExpense > 0) {
      out.push({
        id: "nibt",
        kind: "calculatedResult",
        label: "Profit before tax",
        values: { amount: netIncomeBeforeTax },
      });
    }

    pushSubSection("tax_expense");
    out.push({ id: "pnl-gap", kind: "spacer" });
    out.push({ id: "net-income", kind: "grandTotal", label: "Net profit for the period", values: { amount: netIncome } });

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifiedPnlAccounts, grossProfit, operatingProfit, netIncomeBeforeTax, netIncome, totalOtherIncome, totalOtherExpense]);

  // ─── Balance Sheet columns + rows ───
  const bsColumns = useMemo<ReportColumn[]>(
    () => [
      { key: "name", header: "Account" },
      { key: "balance", header: "Balance", format: "currency", width: "w-[180px]" },
    ],
    [],
  );

  const bsRows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    const grouped = groupBySubType(classifiedBsAccounts);

    const pushSubSection = (subType: AccountSubType) => {
      const accts = grouped.get(subType) || [];
      if (accts.length === 0) return;
      out.push({ id: `sec-${subType}`, kind: "section", label: SUB_TYPE_LABELS[subType] });
      for (const acct of accts) {
        out.push({
          id: acct.id,
          depth: 2,
          meta: { accountId: acct.id },
          onClick: () => handleDrillDown(acct),
          values: { name: acct.name, balance: acct.closing_balance },
        });
      }
      const subTotal = accts.reduce((s, a) => s + a.closing_balance, 0);
      out.push({
        id: `sub-${subType}`,
        kind: "subtotal",
        label: `Total ${SUB_TYPE_LABELS[subType]}`,
        values: { balance: subTotal },
      });
    };

    out.push({ id: "sec-assets", kind: "section", label: "ASSETS" });
    for (const subType of BS_ASSET_ORDER) pushSubSection(subType);
    out.push({
      id: "total-assets",
      kind: "grandTotal",
      label: "Total assets",
      values: { balance: bsData?.balanceSheetTotals?.totalAssets || 0 },
    });

    out.push({ id: "gap-liabilities", kind: "spacer" });
    out.push({ id: "sec-liabilities", kind: "section", label: "LIABILITIES" });
    for (const subType of BS_LIABILITY_ORDER) pushSubSection(subType);
    out.push({
      id: "total-liabilities",
      kind: "majorTotal",
      label: "Total liabilities",
      values: { balance: bsData?.sectionTotals["liability"] || 0 },
    });

    out.push({ id: "gap-equity", kind: "spacer" });
    out.push({ id: "sec-equity", kind: "section", label: "EQUITY" });
    for (const acct of classifiedBsAccounts.filter(a => a.account_type === "equity")) {
      out.push({
        id: acct.id,
        depth: 2,
        meta: { accountId: acct.id },
        onClick: () => handleDrillDown(acct),
        values: { name: acct.name, balance: acct.closing_balance },
      });
    }
    // Equity accounts above already carry every CLOSED year's result (SQL folds
    // it into the retained-earnings account's opening balance). Only the
    // current fiscal year's result is added as a separate line, so no year is
    // presented twice.
    if (bsData?.balanceSheetTotals?.currentYearEarnings) {
      out.push({
        id: "current-year-earnings",
        depth: 2,
        values: {
          name: "Current Year Earnings",
          balance: bsData.balanceSheetTotals.currentYearEarnings,
        },
      });
    }
    if (
      bsData?.balanceSheetTotals &&
      !bsData.balanceSheetTotals.hasRetainedEarningsAccount &&
      bsData.balanceSheetTotals.priorYearsResult !== 0
    ) {
      out.push({
        id: "retained-earnings-missing",
        depth: 2,
        values: {
          name: "No retained earnings account — prior years' result is not presented",
          balance: bsData.balanceSheetTotals.priorYearsResult,
        },
      });
    }

    out.push({
      id: "total-equity",
      kind: "majorTotal",
      label: "Total equity",
      values: { balance: bsData?.balanceSheetTotals?.totalEquity || 0 },
    });

    out.push({ id: "gap-liab-equity", kind: "spacer" });
    out.push({
      id: "total-liab-equity",
      kind: "grandTotal",
      label: "Total liabilities and equity",
      values: { balance: (bsData?.sectionTotals["liability"] || 0) + (bsData?.balanceSheetTotals?.totalEquity || 0) },
    });

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classifiedBsAccounts, bsData]);

  const totalIncome = pnlData?.sectionTotals["income"] || 0;
  const totalExpenses = pnlData?.sectionTotals["expense"] || 0;
  const totalAssets = bsData?.balanceSheetTotals?.totalAssets || 0;

  // ─── Export configs — same row model that drives the screen ───
  const getPnlExportConfig = useCallback((): ExportConfig => ({
    title: "Profit & Loss Statement",
    reportType: "profit_and_loss",
    // Basis of preparation travels with the export, exactly as shown on screen.
    subtitle: "Accrual Basis",
    dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
    columns: toExportColumns(pnlColumns),
    rows: toExportRows(pnlRows, pnlColumns),
    sheetName: "Profit & Loss",
    currency: baseCurrency,
  }), [pnlColumns, pnlRows, dateFrom, dateTo, currentOrg, baseCurrency]);

  const getBsExportConfig = useCallback((): ExportConfig => ({
    title: "Balance Sheet",
    reportType: "balance_sheet",
    subtitle: "Accrual Basis",
    // Point-in-time statement: the masthead states "As of …".
    asOf: format(new Date(dateTo), "MMMM d, yyyy"),
    columns: toExportColumns(bsColumns),
    rows: toExportRows(bsRows, bsColumns),
    sheetName: "Balance Sheet",
    currency: baseCurrency,
  }), [bsColumns, bsRows, dateTo, currentOrg, baseCurrency]);

  const getExportConfig = activeTab === "pnl" ? getPnlExportConfig : getBsExportConfig;

  return (
    <ReportPageLayout
      title="Financial Statements"
      description="Accrual-based financial statements from journal entries"
      isLoading={isLoading}
      error={error as Error | null}
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['financial-report'] as const]} tooltip="Refresh financial statements" />
          <SaveViewButton
            reportType="financial"
            currentFilters={{ activeTab, dateFrom, dateTo, comparisonMode }}
            onLoadView={(filters) => {
              if (filters.activeTab) setActiveTab(filters.activeTab);
              if (filters.dateFrom) setDateFrom(filters.dateFrom);
              if (filters.dateTo) setDateTo(filters.dateTo);
              if (filters.comparisonMode) setComparisonMode(filters.comparisonMode);
            }}
          />
        </>
      }
      filters={
        <ReportFilters
          dateMode={activeTab === "pnl" ? "range" : "asof"}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
        >
          {/* Wave 5: branch filter is context-aware. P&L is branch-sliceable;
              Balance Sheet is entity-only and the component renders an
              "Entity-level report" hint instead of a dropdown. */}
          <ReportBranchFilter reportKind={activeTab === "pnl" ? "pnl" : "balance_sheet"} />
          {activeTab === "pnl" && (
            <div className="space-y-2">
              <Label className="text-xs">Compare</Label>
              <Select value={comparisonMode} onValueChange={(v) => setComparisonMode(v as ComparisonMode)}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Comparison</SelectItem>
                  <SelectItem value="previous_period">Previous Period</SelectItem>
                  <SelectItem value="same_period_last_year">Same Period Last Year</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </ReportFilters>
      }
    >
      {/* Period-lock indicator — figures for closed periods are stable */}
      <PeriodLockBanner
        dateFrom={activeTab === "pnl" ? dateFrom : undefined}
        dateTo={dateTo}
      />

      {/* Data Integrity Warnings */}
      {integrityReport?.hasIssues && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
              <div className="space-y-2">
                <h3 className="font-semibold text-destructive">Data Integrity Issues Detected</h3>
                <p className="text-sm text-muted-foreground">
                  {integrityReport.issueCount} issue{integrityReport.issueCount !== 1 ? 's' : ''} found 
                  affecting {fmt(integrityReport.totalAffectedAmount)} in invoice data. 
                  These issues may impact report accuracy.
                </p>
                <details className="text-sm">
                  <summary className="cursor-pointer text-destructive hover:underline">
                    View Issues ({integrityReport.issueCount})
                  </summary>
                  <div className="mt-2 space-y-1 ml-4">
                    {integrityReport.issues.slice(0, 5).map((issue, index) => (
                      <div key={index} className="text-xs text-muted-foreground">
                        • {issue.description}
                      </div>
                    ))}
                    {integrityReport.issues.length > 5 && (
                      <div className="text-xs text-muted-foreground italic">
                        ...and {integrityReport.issues.length - 5} more issues
                      </div>
                    )}
                  </div>
                </details>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="pnl">Profit & Loss</TabsTrigger>
          <TabsTrigger value="balance_sheet">Balance Sheet</TabsTrigger>
        </TabsList>

        {/* ═══════════════════ PROFIT & LOSS ═══════════════════ */}
        <TabsContent value="pnl" className="space-y-6 mt-6">
          {/* KPI Cards */}
          <div className="stats-grid">
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <span className="text-sm font-medium">Total Revenue</span>
                  <DollarSign className="h-4 w-4 text-success" />
                </div>
                <div className="text-2xl font-bold text-success">{fmt(totalRevenue)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <span className="text-sm font-medium">Gross Profit</span>
                  <TrendingUp className="h-4 w-4 text-primary" />
                </div>
                <div className={cn("text-2xl font-bold", grossProfit >= 0 ? "text-primary" : "text-destructive")}>{fmt(grossProfit)}</div>
                {totalRevenue > 0 && (
                  <p className="text-xs text-muted-foreground">{((grossProfit / totalRevenue) * 100).toFixed(1)}% margin</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <span className="text-sm font-medium">Operating Profit</span>
                  <TrendingDown className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className={cn("text-2xl font-bold", operatingProfit >= 0 ? "text-success" : "text-destructive")}>{fmt(operatingProfit)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <span className="text-sm font-medium">Net Income</span>
                  {netIncome >= 0 ? <ArrowUpRight className="h-4 w-4 text-success" /> : <ArrowDownRight className="h-4 w-4 text-destructive" />}
                </div>
                <div className={cn("text-2xl font-bold", netIncome >= 0 ? "text-success" : "text-destructive")}>{fmt(netIncome)}</div>
              </CardContent>
            </Card>
          </div>

          {/* P&L Table — Multi-Step Format, rendered by the shared reporting engine */}
          <ReportSurface
            title="Profit & Loss Statement"
            dateRange={`${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`}
            subtitle="Accrual Basis"
            profile="financial"
          >
            <ReportTable
              columns={pnlColumns}
              rows={pnlRows}
              currency={baseCurrency}
              caption="Profit & Loss — multi-step statement"
              emptyMessage="No income or expense activity for this period"
            />
          </ReportSurface>
        </TabsContent>

        {/* ═══════════════════ BALANCE SHEET ═══════════════════ */}
        <TabsContent value="balance_sheet" className="space-y-6 mt-6">
          {/* Validation Warnings */}
          {bsData?.validationWarnings && bsData.validationWarnings.length > 0 && (
            <Card className="border-destructive bg-destructive/5">
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
                  <div className="space-y-2">
                    <h3 className="font-semibold text-destructive">Balance Sheet Validation Errors</h3>
                    <div className="text-sm text-destructive/80 space-y-1">
                      {bsData.validationWarnings.map((warning, idx) => (
                        <div key={idx}><strong>Error {idx + 1}:</strong> {warning}</div>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <ReportSurface
            title="Balance Sheet"
            asOfDate={`As of ${format(new Date(dateTo), "MMMM d, yyyy")}`}
            subtitle="Accrual Basis"
            profile="financial"
          >
            <ReportTable
              columns={bsColumns}
              rows={bsRows}
              currency={baseCurrency}
              caption="Balance sheet — assets, liabilities and equity"
              emptyMessage="No account balances as of this date"
            />
          </ReportSurface>

          {/* Balance check */}
          {bsData && (
            <Card className={Math.abs(bsData.totals.netAmount) < 0.01 ? "border-success/50" : "border-destructive"}>
              <CardContent className="py-4">
                <div className="flex items-center gap-3">
                  {Math.abs(bsData.totals.netAmount) < 0.01 ? (
                    <Badge variant="outline" className="text-success border-success text-sm py-1 px-3">
                      ✓ Assets = Liabilities + Equity — Balanced
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="text-sm py-1 px-3">
                      ✗ Imbalance: {fmt(Math.abs(bsData.totals.netAmount))}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <DrillDownDialog
        open={!!drillDown}
        onOpenChange={(open) => !open && setDrillDown(null)}
        config={drillDown}
      />
    </ReportPageLayout>
  );
}


export default function FinancialReports() {
  return (
    // ReportFilterProvider must wrap the inner so useReportFilters() inside
    // FinancialReportsInner reads the SAME context instance that
    // <ReportBranchFilter /> writes to. Otherwise the branch toggle silently
    // updates a sibling provider and the report stays consolidated forever.
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Financial reports">
        <FinancialReportsInner />
      </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
