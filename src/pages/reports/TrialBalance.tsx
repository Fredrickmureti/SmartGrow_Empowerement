/**
 * Trial Balance Page
 *
 * Professional 6-column format: Opening (DR/CR), Movement (DR/CR), Closing (DR/CR).
 * Rendered by the canonical reporting engine (`@/design-system/reports`):
 * the page declares columns + typed rows, the engine owns alignment,
 * hierarchy, sticky headers, formatting, virtualization and PDF parity.
 */

import { useState, useCallback, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { useFinancialReport, type FinancialReportAccount } from "@/hooks/useFinancialReport";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useOpeningBalanceCheck } from "@/hooks/useOpeningBalanceCheck";
import { MigrateOpeningBalancesButton } from "@/components/accounts/MigrateOpeningBalancesButton";
import { isDebitNormal, ACCOUNT_TYPE_LABELS } from "@/services/reports/ReportCalculationEngine";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { DrillDownDialog, type DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import {
  ReportSurface,
  ReportTable,
  blankIfZero,
  formatAccountingNumber,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportColumnGroup,
  type ReportRow,
} from "@/design-system/reports";
import { format } from "date-fns";
import type { ExportConfig } from "@/services/reports/ReportExportService";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";

/** Splits a closing balance into debit/credit columns based on natural balance */
function splitBalance(balance: number, accountType: string): { debit: number; credit: number } {
  const isDebit = isDebitNormal(accountType);
  if (isDebit) {
    return balance >= 0
      ? { debit: balance, credit: 0 }
      : { debit: 0, credit: Math.abs(balance) };
  }
  return balance >= 0
    ? { debit: 0, credit: balance }
    : { debit: Math.abs(balance), credit: 0 };
}

function TrialBalanceInner() {
  const [asOfDate, setAsOfDate] = useState(() => {
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams(window.location.search);
      const v = sp.get("as_of") || sp.get("asOf") || sp.get("date_to") || sp.get("dateTo");
      if (v) return v;
    }
    return format(new Date(), "yyyy-MM-dd");
  });
  const [includeZeroBalances, setIncludeZeroBalances] = useState(false);
  const [drillDown, setDrillDown] = useState<DrillDownConfig | null>(null);
  const { filters } = useReportFilters();

  const { data, isLoading, error } = useFinancialReport({
    reportType: "trial_balance",
    dateFrom: "1970-01-01",
    dateTo: asOfDate,
    includeZeroActivity: includeZeroBalances,
    branchId: filters.branchId,
  });

  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { currentOrg } = useOrganization();
  const { data: openingBalanceCheck } = useOpeningBalanceCheck();

  const handleDrillDown = (acct: FinancialReportAccount) => {
    setDrillDown({
      title: `${acct.code} - ${acct.name}`,
      accountId: acct.id,
      startDate: "1970-01-01",
      endDate: asOfDate,
    });
  };

  const fmt = (amount: number) => formatCurrency(amount, baseCurrency);
  const fmtOrDash = (amount: number) => amount !== 0 ? fmt(amount) : "—";

  // Group accounts by type
  const accountsByType = (data?.accounts || []).reduce((acc, account) => {
    if (account.is_group) return acc;
    const type = account.account_type;
    if (!acc[type]) acc[type] = [];
    acc[type].push(account);
    return acc;
  }, {} as Record<string, FinancialReportAccount[]>);

  const typeOrder = ["asset", "liability", "equity", "income", "expense"];

  // Grand totals for 6-column
  const grandTotals = (data?.accounts || []).filter(a => !a.is_group).reduce(
    (acc, acct) => {
      const openSplit = splitBalance(acct.opening_balance, acct.account_type);
      const closeSplit = splitBalance(acct.closing_balance, acct.account_type);
      acc.openDebit += openSplit.debit;
      acc.openCredit += openSplit.credit;
      acc.movDebit += acct.debit_total;
      acc.movCredit += acct.credit_total;
      acc.closeDebit += closeSplit.debit;
      acc.closeCredit += closeSplit.credit;
      return acc;
    },
    { openDebit: 0, openCredit: 0, movDebit: 0, movCredit: 0, closeDebit: 0, closeCredit: 0 }
  );

  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "code", header: "Code", width: 10 },
      { key: "name", header: "Account Name", width: 25 },
      { key: "open_dr", header: "Opening DR", width: 14, format: "currency", align: "right" },
      { key: "open_cr", header: "Opening CR", width: 14, format: "currency", align: "right" },
      { key: "mov_dr", header: "Movement DR", width: 14, format: "currency", align: "right" },
      { key: "mov_cr", header: "Movement CR", width: 14, format: "currency", align: "right" },
      { key: "close_dr", header: "Closing DR", width: 14, format: "currency", align: "right" },
      { key: "close_cr", header: "Closing CR", width: 14, format: "currency", align: "right" },
    ];

    const rows: ExportRow[] = [];
    for (const type of typeOrder) {
      const accounts = accountsByType[type] || [];
      if (accounts.length === 0) continue;
      rows.push({ code: "", name: ACCOUNT_TYPE_LABELS[type], _isHeader: true });
      for (const acct of accounts) {
        const openSplit = splitBalance(acct.opening_balance, acct.account_type);
        const closeSplit = splitBalance(acct.closing_balance, acct.account_type);
        rows.push({
          code: acct.code, name: acct.name,
          open_dr: openSplit.debit || null, open_cr: openSplit.credit || null,
          mov_dr: acct.debit_total || null, mov_cr: acct.credit_total || null,
          close_dr: closeSplit.debit || null, close_cr: closeSplit.credit || null,
        });
      }
    }

    rows.push({
      code: "", name: "TOTAL", _isGrandTotal: true,
      open_dr: grandTotals.openDebit, open_cr: grandTotals.openCredit,
      mov_dr: grandTotals.movDebit, mov_cr: grandTotals.movCredit,
      close_dr: grandTotals.closeDebit, close_cr: grandTotals.closeCredit,
    });

    return {
      title: "Trial Balance",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `As of ${format(new Date(asOfDate), "MMMM d, yyyy")}`,
      columns, rows, sheetName: "Trial Balance", currency: baseCurrency,
    };
  }, [data, accountsByType, asOfDate, currentOrg, baseCurrency, grandTotals]);

  return (
    <ReportPageLayout
      title="Trial Balance"
      description="Verify that debits equal credits across all accounts"
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!data || data.accounts.length === 0}
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['trial-balance'] as const]} tooltip="Refresh trial balance" />
          <SaveViewButton
            reportType="trial-balance"
            currentFilters={{ asOfDate, includeZeroBalances }}
            onLoadView={(filters) => {
              if (filters.asOfDate) setAsOfDate(filters.asOfDate);
              if (filters.includeZeroBalances !== undefined) setIncludeZeroBalances(filters.includeZeroBalances);
            }}
          />
        </>
      }
      filters={
        <ReportFilters
          dateMode="asof"
          dateFrom={asOfDate}
          dateTo={asOfDate}
          onDateFromChange={setAsOfDate}
          onDateToChange={setAsOfDate}
          showZeroToggle
          includeZeroBalances={includeZeroBalances}
          onZeroBalancesChange={setIncludeZeroBalances}
        >
          <ReportBranchFilter reportKind="trial_balance" />
        </ReportFilters>
      }
    >
      {/* Balance Status */}
      <Card className={data?.isBalanced ? "border-success/50" : "border-destructive"}>
        <CardContent className="py-4">
          <div className="flex items-center gap-3">
            {data?.isBalanced ? (
              <>
                <CheckCircle2 className="h-6 w-6 text-success" />
                <div>
                  <p className="font-medium text-success">Books are Balanced</p>
                  <p className="text-sm text-muted-foreground">Total Debits = Total Credits</p>
                </div>
              </>
            ) : (
              <>
                <AlertCircle className="h-6 w-6 text-destructive" />
                <div>
                  <p className="font-medium text-destructive">Books are NOT Balanced</p>
                  <p className="text-sm text-muted-foreground">
                    Difference: {fmt(Math.abs((data?.totals.totalDebits || 0) - (data?.totals.totalCredits || 0)))}
                  </p>
                  {openingBalanceCheck && !openingBalanceCheck.isBalanced && (
                    <div className="flex items-center gap-3 mt-2">
                      <p className="text-sm text-destructive">
                        ⚠ Opening balance imbalance: {fmt(openingBalanceCheck.imbalance)}.
                      </p>
                      <MigrateOpeningBalancesButton imbalance={openingBalanceCheck.imbalance} />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 6-Column Trial Balance Table */}
      <Card>
        <CardContent className="pt-6">
          <FinancialReportHeader
            companyName={currentOrg?.name || ""}
            reportTitle="Trial Balance"
            asOfDate={`As of ${format(new Date(asOfDate), "MMMM d, yyyy")}`}
          />
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead rowSpan={2} className="w-[80px] align-bottom border-r">Code</TableHead>
                  <TableHead rowSpan={2} className="align-bottom border-r">Account Name</TableHead>
                  <TableHead colSpan={2} className="text-center border-b border-r">Opening Balance</TableHead>
                  <TableHead colSpan={2} className="text-center border-b border-r">Movement</TableHead>
                  <TableHead colSpan={2} className="text-center border-b">Closing Balance</TableHead>
                </TableRow>
                <TableRow>
                  <TableHead className="text-right text-xs w-[110px]">Debit</TableHead>
                  <TableHead className="text-right text-xs w-[110px] border-r">Credit</TableHead>
                  <TableHead className="text-right text-xs w-[110px]">Debit</TableHead>
                  <TableHead className="text-right text-xs w-[110px] border-r">Credit</TableHead>
                  <TableHead className="text-right text-xs w-[110px]">Debit</TableHead>
                  <TableHead className="text-right text-xs w-[110px]">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {typeOrder.map((type) => {
                  const accounts = accountsByType[type] || [];
                  if (accounts.length === 0) return null;

                  const typeTotal = accounts.reduce(
                    (acc, a) => {
                      const openSplit = splitBalance(a.opening_balance, a.account_type);
                      const closeSplit = splitBalance(a.closing_balance, a.account_type);
                      acc.openDebit += openSplit.debit;
                      acc.openCredit += openSplit.credit;
                      acc.movDebit += a.debit_total;
                      acc.movCredit += a.credit_total;
                      acc.closeDebit += closeSplit.debit;
                      acc.closeCredit += closeSplit.credit;
                      return acc;
                    },
                    { openDebit: 0, openCredit: 0, movDebit: 0, movCredit: 0, closeDebit: 0, closeCredit: 0 }
                  );

                  return (
                    <> 
                      <TableRow key={type} className="bg-muted/50 font-medium">
                        <TableCell colSpan={8}>{ACCOUNT_TYPE_LABELS[type]}</TableCell>
                      </TableRow>
                      {accounts.map((account) => {
                        const openSplit = splitBalance(account.opening_balance, account.account_type);
                        const closeSplit = splitBalance(account.closing_balance, account.account_type);

                        return (
                          <TableRow
                            key={account.id}
                            className="cursor-pointer hover:bg-muted/20"
                            onClick={() => handleDrillDown(account)}
                          >
                            <TableCell className="font-mono text-xs border-r">{account.code}</TableCell>
                            <TableCell className="text-sm border-r" style={{ paddingLeft: `${(account.depth + 1) * 12}px` }}>
                              {account.name}
                            </TableCell>
                            <TableCell className="text-right text-sm tabular-nums">{fmtOrDash(openSplit.debit)}</TableCell>
                            <TableCell className="text-right text-sm tabular-nums border-r">{fmtOrDash(openSplit.credit)}</TableCell>
                            <TableCell className="text-right text-sm tabular-nums">{fmtOrDash(account.debit_total)}</TableCell>
                            <TableCell className="text-right text-sm tabular-nums border-r">{fmtOrDash(account.credit_total)}</TableCell>
                            <TableCell className="text-right text-sm tabular-nums">{fmtOrDash(closeSplit.debit)}</TableCell>
                            <TableCell className="text-right text-sm tabular-nums">{fmtOrDash(closeSplit.credit)}</TableCell>
                          </TableRow>
                        );
                      })}
                      <TableRow className="font-medium border-t">
                        <TableCell colSpan={2} className="text-right text-sm border-r">
                          {ACCOUNT_TYPE_LABELS[type]} Total
                        </TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{fmtOrDash(typeTotal.openDebit)}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums border-r">{fmtOrDash(typeTotal.openCredit)}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{fmtOrDash(typeTotal.movDebit)}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums border-r">{fmtOrDash(typeTotal.movCredit)}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{fmtOrDash(typeTotal.closeDebit)}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{fmtOrDash(typeTotal.closeCredit)}</TableCell>
                      </TableRow>
                    </>
                  );
                })}

                {/* Grand Total */}
                <TableRow className="font-bold text-base bg-muted border-t-2">
                  <TableCell colSpan={2} className="border-r">TOTAL</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(grandTotals.openDebit)}</TableCell>
                  <TableCell className="text-right tabular-nums border-r">{fmt(grandTotals.openCredit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(grandTotals.movDebit)}</TableCell>
                  <TableCell className="text-right tabular-nums border-r">{fmt(grandTotals.movCredit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(grandTotals.closeDebit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(grandTotals.closeCredit)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <DrillDownDialog
        open={!!drillDown}
        onOpenChange={(open) => !open && setDrillDown(null)}
        config={drillDown}
      />
    </ReportPageLayout>
  );
}


export default function TrialBalance() {
  return (
    
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Trial Balance">
      <TrialBalanceInner />
    </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
