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
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
import { format, startOfYear } from "date-fns";
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
  // user to the exact period they were investigating.
  //
  // Phase 2: the trial balance is a PERIOD report. `from` defaults to the
  // start of the current calendar year; the opening column is the balance
  // carried into `from`, the movement column is activity inside the period
  // and the closing column is the balance as at `to`. Before this, `from`
  // was hardcoded to 1970-01-01, which made "opening" a static account-setup
  // figure and "movement" inception-to-date.
  const today = format(new Date(), "yyyy-MM-dd");
  const yearStart = format(startOfYear(new Date()), "yyyy-MM-dd");
  const workspace = useReportWorkspaceState({
    from: yearStart,
    to: today,
  });
  const dateFrom = workspace.get("from", yearStart);
  const dateTo = workspace.get("to", today);
  const setDateFrom = (value: string) => workspace.set({ from: value });
  const setDateTo = (value: string) => workspace.set({ to: value });
  const includeZeroBalances = workspace.get("status", "") === "include_zero";
  const setIncludeZeroBalances = (value: boolean) =>
    workspace.set({ status: value ? "include_zero" : "" });
  const [drillDown, setDrillDown] = useState<DrillDownConfig | null>(null);
  const { filters } = useReportFilters();

  const { data, isLoading, error } = useFinancialReport({
    reportType: "trial_balance",
    dateFrom,
    dateTo,
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
      startDate: dateFrom,
      endDate: dateTo,
      branchId: filters.branchId || null,
    });
  };


  const fmt = useCallback(
    (amount: number) => formatAccountingNumber(amount, baseCurrency),
    [baseCurrency],
  );

  // ── One column declaration drives the screen table AND the export ──
  //
  // Two layouts, both standard practice:
  //   simple   — Code · Account name · Debit · Credit (closing balances as at
  //              the period end). This is the classic textbook / QuickBooks
  //              trial balance and the default, because that is the document
  //              an accountant expects to sign.
  //   extended — Opening (Dr/Cr) · Movement (Dr/Cr) · Closing (Dr/Cr) under
  //              explicit band captions, the Odoo / Sage / SAP layout.
  const isExtended = workspace.get("group", "simple") === "extended";
  const setExtended = (value: boolean) =>
    workspace.set({ group: value ? "extended" : "simple" });

  const columns = useMemo<ReportColumn[]>(
    () =>
      isExtended
        ? [
            { key: "code", header: "Code", width: "w-[90px]", sticky: true },
            { key: "name", header: "Account name", width: "w-[280px]", sticky: true, groupEnd: true },
            { key: "open_dr", header: "Debit", format: "currency", width: "w-[130px]" },
            { key: "open_cr", header: "Credit", format: "currency", width: "w-[130px]", groupEnd: true },
            { key: "mov_dr", header: "Debit", format: "currency", width: "w-[130px]" },
            { key: "mov_cr", header: "Credit", format: "currency", width: "w-[130px]", groupEnd: true },
            { key: "close_dr", header: "Debit", format: "currency", width: "w-[130px]" },
            { key: "close_cr", header: "Credit", format: "currency", width: "w-[130px]" },
          ]
        : [
            { key: "code", header: "Code", width: "w-[90px]", sticky: true },
            { key: "name", header: "Account name", sticky: true, groupEnd: true },
            { key: "close_dr", header: "Debit", format: "currency", width: "w-[160px]" },
            { key: "close_cr", header: "Credit", format: "currency", width: "w-[160px]" },
          ],
    [isExtended],
  );

  const columnGroups = useMemo<ReportColumnGroup[]>(
    () =>
      isExtended
        ? [
            { label: "Account", span: 2, align: "left" },
            { label: "Opening balance", span: 2 },
            { label: "Movement", span: 2 },
            { label: "Closing balance", span: 2 },
          ]
        : [],
    [isExtended],
  );


  // Grouping, splitting and totalling happen once — not on every render pass.
  const { rows, grandTotals, abnormalCount } = useMemo(() => {
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
    let abnormal = 0;

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

        // An account closing on the WRONG side of its natural balance — a
        // liability in debit, an asset in credit — is almost always a
        // misposting, not a presentation quirk. A trial balance that
        // silently normalises it hides the error, so flag it here and
        // footnote it on the statement.
        const isAbnormal = acct.closing_balance < 0;
        if (isAbnormal) abnormal += 1;

        out.push({
          id: acct.id,
          depth: acct.depth,
          tone: isAbnormal ? "warning" : undefined,
          onClick: () => handleDrillDown(acct),
          values: {
            code: acct.code,
            name: isAbnormal ? `${acct.name} *` : acct.name,
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
          open_dr: blankIfZero(sub.openDebit), open_cr: blankIfZero(sub.openCredit),
          mov_dr: blankIfZero(sub.movDebit), mov_cr: blankIfZero(sub.movCredit),
          close_dr: blankIfZero(sub.closeDebit), close_cr: blankIfZero(sub.closeCredit),
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
          open_dr: blankIfZero(grand.openDebit), open_cr: blankIfZero(grand.openCredit),
          mov_dr: blankIfZero(grand.movDebit), mov_cr: blankIfZero(grand.movCredit),
          close_dr: blankIfZero(grand.closeDebit), close_cr: blankIfZero(grand.closeCredit),
        },
      });

      if (abnormal > 0) {
        out.push({
          id: "abnormal-note",
          kind: "note",
          label:
            "* Closing balance is on the opposite side to the account's natural balance " +
            "(e.g. a liability in debit). Review these accounts — this usually indicates a misposting.",
        });
      }
    }

    return { rows: out, grandTotals: grand, abnormalCount: abnormal };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, dateFrom, dateTo]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "Trial Balance",
      // Registry key: without it the export silently falls back to the
      // "operational" masthead and drifts from every other statement.
      reportType: "trial_balance",
      // Period report: opening carried into `from`, movement inside the
      // period, closing as at `to`.
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      subtitle: isExtended
        ? "Accrual basis · Opening / Movement / Closing"
        : "Accrual basis · Closing balances",
      // Groups travel with the columns so the PDF prints the same
      // Opening / Movement / Closing band the screen shows.
      columns: toExportColumns(columns, columnGroups),
      rows: toExportRows(rows, columns),
      sheetName: "Trial Balance",
      currency: baseCurrency,
    }),
    [columns, columnGroups, rows, dateFrom, dateTo, currentOrg, baseCurrency, isExtended],
  );



  return (
    <ReportPageLayout
      title="Trial Balance"
      description={
        isExtended
          ? "Opening, movement and closing per account — debits must equal credits"
          : "Closing debit and credit balance per account — debits must equal credits"
      }
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!data || data.accounts.length === 0}
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['trial-balance'] as const]} tooltip="Refresh trial balance" />
          <SaveViewButton
            reportType="trial-balance"
            currentFilters={{ dateFrom, dateTo, includeZeroBalances }}
            onLoadView={(filters) => {
              if (filters.dateFrom) setDateFrom(filters.dateFrom);
              if (filters.dateTo) setDateTo(filters.dateTo);
              if (filters.includeZeroBalances !== undefined) setIncludeZeroBalances(filters.includeZeroBalances);
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
          showZeroToggle
          includeZeroBalances={includeZeroBalances}
          onZeroBalancesChange={setIncludeZeroBalances}
        >
          <ReportBranchFilter reportKind="trial_balance" />
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Layout</Label>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={isExtended ? "extended" : "simple"}
              onValueChange={(value) => {
                if (value) setExtended(value === "extended");
              }}
            >
              <ToggleGroupItem value="simple" aria-label="Simple trial balance">
                Simple
              </ToggleGroupItem>
              <ToggleGroupItem value="extended" aria-label="Extended trial balance">
                Extended
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
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

      {/* Trial balance, rendered by the shared reporting engine */}
      <ReportSurface
        title="Trial Balance"
        asOfDate={`For the period ${format(new Date(dateFrom), "MMMM d, yyyy")} – ${format(new Date(dateTo), "MMMM d, yyyy")}`}
        subtitle={isExtended ? "Accrual basis · Opening / Movement / Closing" : "Accrual basis · Closing balances"}


        profile="operational"
      >
        <ReportTable
          columns={columns}
          columnGroups={columnGroups}
          rows={rows}
          currency={baseCurrency}
          caption={
            isExtended
              ? "Trial balance — opening, movement and closing balances by account"
              : "Trial balance — closing debit and credit balances by account"
          }
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
