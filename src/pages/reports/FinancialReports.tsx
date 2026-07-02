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
 */

import { useState, useCallback, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DollarSign, TrendingUp, TrendingDown, PiggyBank, ArrowUpRight, ArrowDownRight, AlertTriangle, ExternalLink } from "lucide-react";
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
import { FinancialReportHeader } from "@/components/reports/FinancialReportHeader";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { useNavigate } from "react-router-dom";
import { ACCOUNT_TYPE_LABELS } from "@/services/reports/ReportCalculationEngine";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import {
  classifyAccount,
  groupBySubType,
  SUB_TYPE_LABELS,
  BS_ASSET_ORDER,
  BS_LIABILITY_ORDER,
  PNL_INCOME_ORDER,
  PNL_EXPENSE_ORDER,
  type AccountSubType,
  type ClassifiedAccount,
} from "@/services/reports/AccountClassification";
import type { ExportConfig, ExportColumn, ExportRow } from "@/services/reports/ReportExportService";
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

  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
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
    const isBalanceSheet = activeTab === "bs";
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

  const fmt = (amount: number) => formatCurrency(amount, baseCurrency);

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

  const totalIncome = pnlData?.sectionTotals["income"] || 0;
  const totalExpenses = pnlData?.sectionTotals["expense"] || 0;
  const totalAssets = bsData?.balanceSheetTotals?.totalAssets || 0;

  // ─── Export configs ───
  const getPnlExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "name", header: "Account", width: 35 },
      { key: "amount", header: "Amount", width: 18, format: "currency", align: "right" },
      ...(showComparison ? [
        { key: "comparison", header: comparison.label || "Previous", width: 18, format: "currency" as const, align: "right" as const },
        { key: "variance", header: "Variance", width: 14, format: "currency" as const, align: "right" as const },
        { key: "variance_pct", header: "Var %", width: 10, align: "right" as const },
      ] : []),
    ];

    const rows: ExportRow[] = [];
    const pnlGrouped = groupBySubType(classifiedPnlAccounts);

    // Revenue
    rows.push({ name: "REVENUE", amount: null, _isHeader: true });
    for (const acct of pnlGrouped.get("revenue") || []) {
      rows.push({ name: acct.name, amount: acct.display_amount, _depth: 1 });
    }
    rows.push({ name: "Total Revenue", amount: totalRevenue, _isSubtotal: true });

    // COGS
    const cogsAccts = pnlGrouped.get("cost_of_sales") || [];
    if (cogsAccts.length > 0) {
      rows.push({ name: "COST OF SALES", amount: null, _isHeader: true });
      for (const acct of cogsAccts) {
        rows.push({ name: acct.name, amount: acct.display_amount, _depth: 1 });
      }
      rows.push({ name: "Total Cost of Sales", amount: totalCOGS, _isSubtotal: true });
    }
    rows.push({ name: "GROSS PROFIT", amount: grossProfit, _isGrandTotal: true });

    // OpEx
    rows.push({ name: "OPERATING EXPENSES", amount: null, _isHeader: true });
    for (const acct of pnlGrouped.get("operating_expense") || []) {
      rows.push({ name: acct.name, amount: acct.display_amount, _depth: 1 });
    }
    rows.push({ name: "Total Operating Expenses", amount: totalOpEx, _isSubtotal: true });
    rows.push({ name: "OPERATING PROFIT", amount: operatingProfit, _isGrandTotal: true });
    rows.push({ name: "NET INCOME", amount: netIncome, _isGrandTotal: true });

    return {
      title: "Profit & Loss Statement",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns, rows, sheetName: "Profit & Loss", currency: baseCurrency,
    };
  }, [classifiedPnlAccounts, dateFrom, dateTo, currentOrg, baseCurrency, showComparison, comparison.label, totalRevenue, totalCOGS, grossProfit, totalOpEx, operatingProfit, netIncome]);

  const getBsExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "name", header: "Account", width: 35 },
      { key: "balance", header: "Balance", width: 18, format: "currency", align: "right" },
    ];
    const rows: ExportRow[] = [];
    if (bsData) {
      const bsGrouped = groupBySubType(classifiedBsAccounts);
      
      // Assets
      rows.push({ name: "ASSETS", balance: null, _isHeader: true });
      for (const subType of BS_ASSET_ORDER) {
        const accts = bsGrouped.get(subType) || [];
        if (accts.length === 0) continue;
        rows.push({ name: SUB_TYPE_LABELS[subType], balance: null, _isHeader: true });
        for (const acct of accts) {
          rows.push({ name: acct.name, balance: acct.closing_balance, _depth: 2 });
        }
        const subTotal = accts.reduce((s, a) => s + a.closing_balance, 0);
        rows.push({ name: `Total ${SUB_TYPE_LABELS[subType]}`, balance: subTotal, _isSubtotal: true });
      }
      rows.push({ name: "TOTAL ASSETS", balance: bsData.balanceSheetTotals?.totalAssets || 0, _isGrandTotal: true });

      // Liabilities
      rows.push({ name: "LIABILITIES", balance: null, _isHeader: true });
      for (const subType of BS_LIABILITY_ORDER) {
        const accts = bsGrouped.get(subType) || [];
        if (accts.length === 0) continue;
        rows.push({ name: SUB_TYPE_LABELS[subType], balance: null, _isHeader: true });
        for (const acct of accts) {
          rows.push({ name: acct.name, balance: acct.closing_balance, _depth: 2 });
        }
        const subTotal = accts.reduce((s, a) => s + a.closing_balance, 0);
        rows.push({ name: `Total ${SUB_TYPE_LABELS[subType]}`, balance: subTotal, _isSubtotal: true });
      }
      rows.push({ name: "TOTAL LIABILITIES", balance: bsData.sectionTotals["liability"] || 0, _isSubtotal: true });

      // Equity
      rows.push({ name: "EQUITY", balance: null, _isHeader: true });
      for (const acct of (bsGrouped.get("share_capital") || [])) {
        rows.push({ name: acct.name, balance: acct.closing_balance, _depth: 1 });
      }
      if (bsData.balanceSheetTotals?.retainedEarnings) {
        rows.push({ name: "Current Year Earnings", balance: bsData.balanceSheetTotals.retainedEarnings, _depth: 1 });
      }
      rows.push({ name: "TOTAL EQUITY", balance: bsData.balanceSheetTotals?.totalEquity || 0, _isSubtotal: true });

      rows.push({
        name: "TOTAL LIABILITIES & EQUITY",
        balance: (bsData.sectionTotals["liability"] || 0) + (bsData.balanceSheetTotals?.totalEquity || 0),
        _isGrandTotal: true,
      });
    }
    return {
      title: "Balance Sheet", companyName: currentOrg?.name || "", organizationId: currentOrg?.id,
      dateRange: `As of ${format(new Date(dateTo), "MMMM d, yyyy")}`,
      columns, rows, sheetName: "Balance Sheet", currency: baseCurrency,
    };
  }, [bsData, classifiedBsAccounts, dateTo, currentOrg, baseCurrency]);

  const getExportConfig = activeTab === "pnl" ? getPnlExportConfig : getBsExportConfig;

  // ─── Render helpers ───

  /** Renders a sub-section of accounts (e.g., Current Assets) */
  const renderSubSection = (
    accounts: ClassifiedAccount[],
    subType: AccountSubType,
    showSubHeader: boolean = true
  ) => {
    const filtered = accounts.filter(a => a.sub_type === subType);
    if (filtered.length === 0) return null;
    const subTotal = filtered.reduce((s, a) => s + a.closing_balance, 0);

    return (
      <>
        {showSubHeader && (
          <TableRow className="bg-muted/30">
            <TableCell className="pl-8 font-medium text-sm text-muted-foreground" colSpan={2}>
              {SUB_TYPE_LABELS[subType]}
            </TableCell>
          </TableRow>
        )}
        {filtered.map(acct => (
          <TableRow
            key={acct.id}
            className="cursor-pointer hover:bg-muted/20 group"
            onClick={() => handleDrillDown(acct)}
          >
            <TableCell className="pl-12 text-sm">
              <span className="flex items-center gap-1.5">
                {acct.name}
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
                  title="View in General Ledger"
                  onClick={(e) => { e.stopPropagation(); handleViewInGL(acct); }}
                >
                  <ExternalLink className="h-3 w-3" />
                </button>
              </span>
            </TableCell>
            <TableCell className="text-right font-medium text-sm tabular-nums">
              {fmt(acct.closing_balance)}
            </TableCell>
          </TableRow>
        ))}
        {showSubHeader && (
          <TableRow className="font-semibold">
            <TableCell className="pl-8 text-sm">Total {SUB_TYPE_LABELS[subType]}</TableCell>
            <TableCell className="text-right text-sm tabular-nums">{fmt(subTotal)}</TableCell>
          </TableRow>
        )}
      </>
    );
  };

  /** Renders P&L account rows for a sub-type */
  const renderPnlSubSection = (
    accounts: ClassifiedAccount[],
    subType: AccountSubType,
    showHeader: boolean = true
  ) => {
    const filtered = accounts.filter(a => a.sub_type === subType);
    if (filtered.length === 0) return null;
    const subTotal = filtered.reduce((s, a) => s + a.display_amount, 0);

    return (
      <>
        {showHeader && (
          <TableRow className="bg-muted/30">
            <TableCell className="font-medium text-sm text-muted-foreground" colSpan={showComparison ? 5 : 2}>
              {SUB_TYPE_LABELS[subType]}
            </TableCell>
          </TableRow>
        )}
        {filtered.map(acct => (
          <TableRow
            key={acct.id}
            className="cursor-pointer hover:bg-muted/20 group"
            onClick={() => handleDrillDown(acct)}
          >
            <TableCell className="pl-8 text-sm">
              <span className="flex items-center gap-1.5">
                {acct.name}
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
                  title="View in General Ledger"
                  onClick={(e) => { e.stopPropagation(); handleViewInGL(acct); }}
                >
                  <ExternalLink className="h-3 w-3" />
                </button>
              </span>
            </TableCell>
            <TableCell className="text-right font-medium text-sm tabular-nums">{fmt(acct.display_amount)}</TableCell>
            {showComparison && (
              <>
                <TableCell className="text-right text-muted-foreground text-sm tabular-nums">
                  {acct.comparison_amount != null ? fmt(acct.comparison_amount) : "—"}
                </TableCell>
                <TableCell className={cn("text-right text-sm font-medium tabular-nums", (acct.variance || 0) > 0 ? "text-success" : (acct.variance || 0) < 0 ? "text-destructive" : "")}>
                  {acct.variance != null ? `${acct.variance > 0 ? "+" : ""}${fmt(acct.variance)}` : "—"}
                </TableCell>
                <TableCell className={cn("text-right text-sm tabular-nums", (acct.variance_percent || 0) > 0 ? "text-success" : (acct.variance_percent || 0) < 0 ? "text-destructive" : "text-muted-foreground")}>
                  {acct.variance_percent != null ? `${acct.variance_percent > 0 ? "+" : ""}${acct.variance_percent.toFixed(1)}%` : "—"}
                </TableCell>
              </>
            )}
          </TableRow>
        ))}
        {showHeader && (
          <TableRow className="font-semibold">
            <TableCell className="text-sm">Total {SUB_TYPE_LABELS[subType]}</TableCell>
            <TableCell className="text-right text-sm tabular-nums">{fmt(subTotal)}</TableCell>
            {showComparison && <TableCell colSpan={3} />}
          </TableRow>
        )}
      </>
    );
  };

  /** Grand total / separator row */
  const renderTotalRow = (label: string, amount: number, variant: "major" | "section" | "highlight" = "section") => {
    const styles = {
      major: "font-bold text-base bg-muted border-t-2 border-b-2",
      section: "font-semibold border-t",
      highlight: "font-bold text-base border-t-2 border-double",
    };
    return (
      <TableRow className={styles[variant]}>
        <TableCell className={variant === "major" ? "text-base" : "text-sm"}>{label}</TableCell>
        <TableCell className={cn("text-right tabular-nums", variant === "major" ? "text-base" : "text-sm")}>
          {fmt(amount)}
        </TableCell>
        {showComparison && activeTab === "pnl" && <TableCell colSpan={3} />}
      </TableRow>
    );
  };

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
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
                <DollarSign className="h-4 w-4 text-success" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-success">{fmt(totalRevenue)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Gross Profit</CardTitle>
                <TrendingUp className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className={cn("text-2xl font-bold", grossProfit >= 0 ? "text-primary" : "text-destructive")}>{fmt(grossProfit)}</div>
                {totalRevenue > 0 && (
                  <p className="text-xs text-muted-foreground">{((grossProfit / totalRevenue) * 100).toFixed(1)}% margin</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Operating Profit</CardTitle>
                <TrendingDown className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className={cn("text-2xl font-bold", operatingProfit >= 0 ? "text-success" : "text-destructive")}>{fmt(operatingProfit)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Net Income</CardTitle>
                {netIncome >= 0 ? <ArrowUpRight className="h-4 w-4 text-success" /> : <ArrowDownRight className="h-4 w-4 text-destructive" />}
              </CardHeader>
              <CardContent>
                <div className={cn("text-2xl font-bold", netIncome >= 0 ? "text-success" : "text-destructive")}>{fmt(netIncome)}</div>
              </CardContent>
            </Card>
          </div>

          {/* P&L Table — Multi-Step Format */}
          <Card>
            <CardContent className="pt-6">
              <FinancialReportHeader
                companyName={currentOrg?.name || ""}
                reportTitle="Profit & Loss Statement"
                dateRange={`${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`}
                subtitle="Accrual Basis"
              />
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right w-[160px]">Amount</TableHead>
                      {showComparison && (
                        <>
                          <TableHead className="text-right w-[140px]">Previous</TableHead>
                          <TableHead className="text-right w-[120px]">Variance</TableHead>
                          <TableHead className="text-right w-[80px]">%</TableHead>
                        </>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {/* Revenue */}
                    {renderPnlSubSection(classifiedPnlAccounts, "revenue")}

                    {/* Cost of Sales */}
                    {renderPnlSubSection(classifiedPnlAccounts, "cost_of_sales")}

                    {/* Gross Profit */}
                    {renderTotalRow("GROSS PROFIT", grossProfit, "highlight")}

                    {/* Operating Expenses */}
                    {renderPnlSubSection(classifiedPnlAccounts, "operating_expense")}

                    {/* Operating Profit */}
                    {renderTotalRow("OPERATING PROFIT", operatingProfit, "highlight")}

                    {/* Other Income */}
                    {renderPnlSubSection(classifiedPnlAccounts, "other_income")}

                    {/* Other Expenses */}
                    {renderPnlSubSection(classifiedPnlAccounts, "other_expense")}

                    {/* Net Income Before Tax */}
                    {(totalOtherIncome > 0 || totalOtherExpense > 0) && renderTotalRow("NET INCOME BEFORE TAX", netIncomeBeforeTax, "section")}

                    {/* Tax Expense */}
                    {renderPnlSubSection(classifiedPnlAccounts, "tax_expense")}

                    {/* Net Income */}
                    {renderTotalRow("NET INCOME", netIncome, "major")}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
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

          <Card>
            <CardContent className="pt-6">
              <FinancialReportHeader
                companyName={currentOrg?.name || ""}
                reportTitle="Balance Sheet"
                asOfDate={`As of ${format(new Date(dateTo), "MMMM d, yyyy")}`}
                subtitle="Accrual Basis"
              />
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right w-[180px]">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {/* ─── ASSETS ─── */}
                    <TableRow className="bg-muted/50 font-bold">
                      <TableCell colSpan={2} className="text-base">ASSETS</TableCell>
                    </TableRow>
                    {BS_ASSET_ORDER.map(subType => renderSubSection(classifiedBsAccounts, subType))}
                    {renderTotalRow("TOTAL ASSETS", bsData?.balanceSheetTotals?.totalAssets || 0, "major")}

                    {/* ─── Visual separator ─── */}
                    <TableRow>
                      <TableCell colSpan={2} className="h-2 p-0 border-b-2 border-border" />
                    </TableRow>

                    {/* ─── LIABILITIES ─── */}
                    <TableRow className="bg-muted/50 font-bold">
                      <TableCell colSpan={2} className="text-base">LIABILITIES</TableCell>
                    </TableRow>
                    {BS_LIABILITY_ORDER.map(subType => renderSubSection(classifiedBsAccounts, subType))}
                    {renderTotalRow("TOTAL LIABILITIES", bsData?.sectionTotals["liability"] || 0, "section")}

                    {/* ─── EQUITY ─── */}
                    <TableRow className="bg-muted/50 font-bold">
                      <TableCell colSpan={2} className="text-base">EQUITY</TableCell>
                    </TableRow>
                    {classifiedBsAccounts
                      .filter(a => a.account_type === "equity")
                      .map(acct => (
                        <TableRow
                          key={acct.id}
                          className="cursor-pointer hover:bg-muted/20"
                          onClick={() => handleDrillDown(acct)}
                        >
                          <TableCell className="pl-8 text-sm">{acct.name}</TableCell>
                          <TableCell className="text-right font-medium text-sm tabular-nums">
                            {fmt(acct.closing_balance)}
                          </TableCell>
                        </TableRow>
                      ))}
                    {bsData?.balanceSheetTotals?.retainedEarnings !== undefined &&
                      bsData.balanceSheetTotals.retainedEarnings !== 0 && (
                        <TableRow>
                          <TableCell className="pl-8 text-sm italic text-muted-foreground">
                            Current Year Earnings
                          </TableCell>
                          <TableCell className="text-right font-medium text-sm tabular-nums">
                            {fmt(bsData.balanceSheetTotals.retainedEarnings)}
                          </TableCell>
                        </TableRow>
                      )}
                    {renderTotalRow("TOTAL EQUITY", bsData?.balanceSheetTotals?.totalEquity || 0, "section")}

                    {/* ─── TOTAL L + E ─── */}
                    {renderTotalRow(
                      "TOTAL LIABILITIES & EQUITY",
                      (bsData?.sectionTotals["liability"] || 0) + (bsData?.balanceSheetTotals?.totalEquity || 0),
                      "major"
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

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
