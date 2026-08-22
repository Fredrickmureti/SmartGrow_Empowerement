/**
 * General Ledger Page
 *
 * Detailed transaction history for all accounts with export,
 * drill-down, and the standard ReportPageLayout. Rendered by the
 * canonical reporting engine (`@/design-system/reports`) as a single
 * virtualized register — sections per account, subtotal per account,
 * grand total at the foot — rather than N collapsible tables.
 */

import { useState, useCallback, useMemo } from "react";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useReportWorkspaceState } from "@/hooks/reports/useReportWorkspaceState";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ExternalLink } from "lucide-react";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";
import { useGeneralLedger } from "@/hooks/useGeneralLedger";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { format, startOfMonth, endOfMonth } from "date-fns";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import {
  ReportSurface,
  ReportTable,
  blankIfZero,
  toExportColumns,
  toExportRows,
  type ReportColumn,
  type ReportRow,
} from "@/design-system/reports";

function GeneralLedgerInner() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const now = new Date();
  const { filters } = useReportFilters();
  // Scope (period + account) is URL-owned, so the ledger a user drilled into
  // is still there after Back, refresh or a switch to the Journal report.
  const workspace = useReportWorkspaceState();
  const dateFrom = workspace.get(
    "from",
    searchParams.get("date_from") || filters.dateFrom || format(startOfMonth(now), "yyyy-MM-dd"),
  );
  const dateTo = workspace.get(
    "to",
    searchParams.get("date_to") || filters.dateTo || format(endOfMonth(now), "yyyy-MM-dd"),
  );
  const setDateFrom = (value: string) => workspace.set({ from: value });
  const setDateTo = (value: string) => workspace.set({ to: value });
  // Legacy `account_id` deep links (Chart of Accounts "View Register") keep
  // working: they seed the scope, the workspace param then owns it.
  const selectedAccountId = workspace.get(
    "contact",
    searchParams.get("account_id") || "all",
  );
  const setSelectedAccountId = (value: string) => workspace.set({ contact: value });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSource, setDrawerSource] = useState<{ type: string | null; id: string | null }>({ type: null, id: null });

  const { accounts: allAccounts } = useAccounts();
  const { data, isLoading, error } = useGeneralLedger({
    dateFrom,
    dateTo,
    accountIds: selectedAccountId !== "all" ? [selectedAccountId] : undefined,
    includeZeroActivity: false,
    branchId: filters.branchId,
  });

  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();
  const { currentOrg } = useOrganization();

  const openSource = useCallback((sourceType: string | null, sourceId: string | null, lineId: string) => {
    if (sourceType && sourceId) {
      setDrawerSource({ type: sourceType, id: sourceId });
      setDrawerOpen(true);
      return;
    }
    // Resolve JE id from the line id, then preview the JE.
    void (async () => {
      const { data: line } = await supabase
        .from("journal_entry_lines")
        .select("journal_entry_id")
        .eq("id", lineId)
        .maybeSingle();
      if (line?.journal_entry_id) {
        setDrawerSource({ type: "journal_entry", id: line.journal_entry_id });
        setDrawerOpen(true);
      } else {
        navigate(`/finance/journal-entries`);
      }
    })();
  }, [navigate]);

  // Dimensions that only earn their column width when they carry
  // information: the branch column is pointless in a single-branch run, and
  // the currency column is noise when everything is already in base currency.
  const showBranchColumn = useMemo(
    () =>
      !filters.branchId &&
      (data?.accounts || []).some((a) => a.transactions.some((t) => !!t.branch_name)),
    [data, filters.branchId],
  );
  const showCurrencyColumn = useMemo(
    () =>
      (data?.accounts || []).some((a) =>
        a.transactions.some((t) => !!t.entry_currency && t.entry_currency !== baseCurrency),
      ),
    [data, baseCurrency],
  );

  // ── One column declaration drives the screen table AND the export ──
  const columns = useMemo<ReportColumn<ReportRow>[]>(
    () => [
      { key: "date", header: "Date", format: "date", width: "w-[110px]" },
      {
        key: "entry",
        header: "Entry #",
        width: "w-[130px]",
        render: (row) => {
          const v = row.values;
          if (!v?.entry) return null;
          return (
            <button
              className="text-primary hover:underline cursor-pointer bg-transparent border-none p-0 font-mono text-sm"
              onClick={(e) => {
                e.stopPropagation();
                openSource(v._sourceType as string | null, v._sourceId as string | null, v._lineId as string);
              }}
            >
              {v.entry as string}
            </button>
          );
        },
      },
      { key: "journal", header: "Journal", width: "w-[120px]" },
      ...(showBranchColumn
        ? [{ key: "branch", header: "Branch", width: "w-[130px]" } as ReportColumn<ReportRow>]
        : []),
      {
        key: "description",
        header: "Description",
        render: (row) => {
          const v = row.values;
          return (
            <div className="flex items-center gap-2">
              <span>{v?.description as string}</span>
              {v?._reference && <span className="text-xs text-muted-foreground">(Ref: {v._reference as string})</span>}
              {v?._sourceType && v?._sourceId && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  title={`View ${v._sourceType}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openSource(v._sourceType as string, v._sourceId as string, v._lineId as string);
                  }}
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
              )}
            </div>
          );
        },
      },
      // A reversed original stays in the ledger next to its reversal; the
      // reader has to be able to tell which line is which.
      { key: "status", header: "Status", width: "w-[150px]" },
      ...(showCurrencyColumn
        ? [{ key: "currency", header: "Currency", width: "w-[90px]" } as ReportColumn<ReportRow>]
        : []),
      { key: "debit", header: "Debit", format: "currency", width: "w-[140px]" },
      { key: "credit", header: "Credit", format: "currency", width: "w-[140px]" },
      { key: "balance", header: "Balance", format: "currency", width: "w-[140px]" },
    ],
    [openSource, showBranchColumn, showCurrencyColumn],
  );


  const rows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    for (const account of data?.accounts || []) {
      out.push({
        id: `sec-${account.account_id}`,
        kind: "section",
        label: `${account.account_code} - ${account.account_name}`,
      });
      out.push({
        id: `open-${account.account_id}`,
        values: { description: "Opening Balance", balance: account.opening_balance },
      });
      for (const txn of account.transactions) {
        const status = txn.is_reversal
          ? txn.reversal_of_number
            ? `Reversal of ${txn.reversal_of_number}`
            : "Reversal"
          : txn.entry_status === "reversed"
            ? "Reversed"
            : null;
        out.push({
          id: txn.id,
          values: {
            date: txn.entry_date,
            entry: txn.entry_number,
            journal: txn.journal_book ?? null,
            branch: txn.branch_name ?? null,
            description: txn.description,
            status,
            currency: txn.entry_currency ?? null,
            debit: blankIfZero(txn.debit_amount),
            credit: blankIfZero(txn.credit_amount),
            balance: txn.running_balance,
            _reference: txn.reference ?? null,
            _sourceType: txn.source_type ?? null,
            _sourceId: txn.source_id ?? null,
            _lineId: txn.id,
          },
        });
      }

      out.push({
        id: `sub-${account.account_id}`,
        kind: "subtotal",
        label: "Total Movement",
        values: {
          debit: account.total_debits,
          credit: account.total_credits,
          balance: account.closing_balance,
        },
      });
    }
    if (out.length > 0) {
      // The grand total is a debit = credit proof across every account in
      // scope, so a summed "balance" is meaningless there — it nets to nil.
      // The one case where the cell carries information is a single-account
      // run: then it is that account's closing balance. Otherwise it stays
      // genuinely empty rather than printing a figure nobody can tie out.
      const accts = data?.accounts || [];
      out.push({
        id: "grand-total",
        kind: "grandTotal",
        label: "GRAND TOTAL",
        values: {
          debit: data?.grandTotals.debits || 0,
          credit: data?.grandTotals.credits || 0,
          balance: accts.length === 1 ? accts[0].closing_balance : null,
        },
      });
    }
    return out;
  }, [data]);

  const getExportConfig = useCallback(
    (): ExportConfig => ({
      title: "General Ledger",
      reportType: "general_ledger",
      companyName: currentOrg?.name || "",
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: toExportColumns(columns),
      rows: toExportRows(rows, columns),
      sheetName: "General Ledger",
      currency: baseCurrency,
    }),
    [columns, rows, dateFrom, dateTo, currentOrg, baseCurrency],
  );

  return (
    <ReportPageLayout
      title="General Ledger"
      description="Detailed transaction history for all accounts"
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!data || data.accounts.length === 0}
      emptyMessage="No transactions found for the selected period"
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['general-ledger'] as const]} tooltip="Refresh general ledger" />
          <SaveViewButton
            reportType="general-ledger"
            currentFilters={{ dateFrom, dateTo, selectedAccountId }}
            onLoadView={(filters) => {
              if (filters.dateFrom) setDateFrom(filters.dateFrom);
              if (filters.dateTo) setDateTo(filters.dateTo);
              if (filters.selectedAccountId) setSelectedAccountId(filters.selectedAccountId);
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
          <ReportBranchFilter reportKind="general_ledger" />
          <div className="space-y-2 min-w-[200px]">
            <Label>Account</Label>
            <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Accounts</SelectItem>
                {allAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.code} - {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </ReportFilters>
      }
    >
      {/* Summary */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Accounts with Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{data?.accounts.length || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Debits</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatCurrency(data?.grandTotals.debits || 0, baseCurrency)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Total Credits</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatCurrency(data?.grandTotals.credits || 0, baseCurrency)}</p>
          </CardContent>
        </Card>
      </div>

      <ReportSurface
        title="General Ledger"
        dateRange={`${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`}
        profile="operational"
      >
        <ReportTable
          columns={columns}
          rows={rows}
          currency={baseCurrency}
          caption="General ledger — transaction detail and running balance by account"
          emptyMessage="No transactions found for the selected period"
        />
      </ReportSurface>

      <TransactionPreviewDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        sourceType={drawerSource.type}
        sourceId={drawerSource.id}
      />
    </ReportPageLayout>
  );
}

export default function GeneralLedger() {
  return (
    <ReportFilterProvider>
      <GeneralLedgerInner />
    </ReportFilterProvider>
  );
}
