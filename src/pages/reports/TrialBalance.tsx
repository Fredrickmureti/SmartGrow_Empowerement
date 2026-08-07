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
import { useReportWorkspaceState } from "@/hooks/reports/useReportWorkspaceState";
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
  // Reporting scope lives in the URL (`useReportWorkspaceState`) so a
  // drill-down, a switch to General Ledger and the Back button all return the
  // user to the exact as-of date they were investigating.
  const workspace = useReportWorkspaceState({
    asOf: format(new Date(), "yyyy-MM-dd"),
  });
  const asOfDate = workspace.get("asOf", format(new Date(), "yyyy-MM-dd"));
  const setAsOfDate = (value: string) => workspace.set({ asOf: value });
  const includeZeroBalances = workspace.get("status", "") === "include_zero";
  const setIncludeZeroBalances = (value: boolean) =>
    workspace.set({ status: value ? "include_zero" : "" });
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

  const fmt = useCallback(
    (amount: number) => formatAccountingNumber(amount, baseCurrency),
    [baseCurrency],
  );

  // ── One column declaration drives the screen table AND the export ──
  const columns = useMemo<ReportColumn[]>(
    () => [
      { key: "code", header: "Code", width: "w-[90px]", sticky: true },
      { key: "name", header: "Account name", width: "w-[280px]", sticky: true, groupEnd: true },
      { key: "open_dr", header: "Debit", format: "currency", width: "w-[130px]" },
      { key: "open_cr", header: "Credit", format: "currency", width: "w-[130px]", groupEnd: true },
      { key: "mov_dr", header: "Debit", format: "currency", width: "w-[130px]" },
      { key: "mov_cr", header: "Credit", format: "currency", width: "w-[130px]", groupEnd: true },
      { key: "close_dr", header: "Debit", format: "currency", width: "w-[130px]" },
      { key: "close_cr", header: "Credit", format: "currency", width: "w-[130px]" },
    ],
    [],
  );

  const columnGroups = useMemo<ReportColumnGroup[]>(
    () => [
      { label: "Account", span: 2, align: "left" },
      { label: "Opening balance", span: 2 },
      { label: "Movement", span: 2 },
      { label: "Closing balance", span: 2 },
    ],
    [],
  );

  // Grouping, splitting and totalling happen once — not on every render pass.
  const { rows, grandTotals } = useMemo(() => {
    const accounts = (data?.accounts || []).filter((a) => !a.is_group);
    const byType = accounts.reduce<Record<string, FinancialReportAccount[]>>((acc, account) => {
      (acc[account.account_type] ||= []).push(account);
      return acc;
    }, {});

    const typeOrder = ["asset", "liability", "equity", "income", "expense"];
    const out: ReportRow[] = [];
    const grand = {
      openDebit: 0, openCredit: 0, movDebit: 0, movCredit: 0, closeDebit: 0, closeCredit: 0,
    };

    for (const type of typeOrder) {
      const list = byType[type] || [];
      if (list.length === 0) continue;

      out.push({ id: `sec-${type}`, kind: "section", label: ACCOUNT_TYPE_LABELS[type] });
      const sub = { openDebit: 0, openCredit: 0, movDebit: 0, movCredit: 0, closeDebit: 0, closeCredit: 0 };

      for (const acct of list) {
        const open = splitBalance(acct.opening_balance, acct.account_type);
        const close = splitBalance(acct.closing_balance, acct.account_type);
        sub.openDebit += open.debit;
        sub.openCredit += open.credit;
        sub.movDebit += acct.debit_total;
        sub.movCredit += acct.credit_total;
        sub.closeDebit += close.debit;
        sub.closeCredit += close.credit;

        out.push({
          id: acct.id,
          depth: acct.depth,
          onClick: () => handleDrillDown(acct),
          values: {
            code: acct.code,
            name: acct.name,
            open_dr: blankIfZero(open.debit),
            open_cr: blankIfZero(open.credit),
            mov_dr: blankIfZero(acct.debit_total),
            mov_cr: blankIfZero(acct.credit_total),
            close_dr: blankIfZero(close.debit),
            close_cr: blankIfZero(close.credit),
          },
        });
      }

      out.push({
        id: `sub-${type}`,
        kind: "subtotal",
        label: `${ACCOUNT_TYPE_LABELS[type]} total`,
        values: {
          open_dr: sub.openDebit, open_cr: sub.openCredit,
          mov_dr: sub.movDebit, mov_cr: sub.movCredit,
          close_dr: sub.closeDebit, close_cr: sub.closeCredit,
        },
      });

      grand.openDebit += sub.openDebit;
      grand.openCredit += sub.openCredit;
      grand.movDebit += sub.movDebit;
      grand.movCredit += sub.movCredit;
      grand.closeDebit += sub.closeDebit;
      grand.closeCredit += sub.closeCredit;
    }

    if (out.length > 0) {
      out.push({
        id: "grand-total",
        kind: "grandTotal",
        label: "TOTAL",
        values: {
          open_dr: grand.openDebit, open_cr: grand.openCredit,
          mov_dr: grand.movDebit, mov_cr: grand.movCredit,
          close_dr: grand.closeDebit, close_cr: grand.closeCredit,
        },
      });
    }

    return { rows: out, grandTotals: grand };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, asOfDate]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "Trial Balance",
      dateRange: `As of ${format(new Date(asOfDate), "MMMM d, yyyy")}`,
      columns: toExportColumns(columns),
      rows: toExportRows(rows, columns),
      sheetName: "Trial Balance",
      currency: baseCurrency,
    }),
    [columns, rows, asOfDate, currentOrg, baseCurrency],
  );


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

      {/* 6-column trial balance, rendered by the shared reporting engine */}
      <ReportSurface
        title="Trial Balance"
        asOfDate={`As of ${format(new Date(asOfDate), "MMMM d, yyyy")}`}
        subtitle={filters.branchId ? "Branch scoped" : undefined}
        profile="financial"
      >
        <ReportTable
          columns={columns}
          columnGroups={columnGroups}
          rows={rows}
          currency={baseCurrency}
          caption="Trial balance — opening, movement and closing balances by account"
          emptyMessage="No account activity as of this date"
        />
      </ReportSurface>


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
