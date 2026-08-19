/**
 * Account Register Page
 * 
 * Dedicated transaction register for a single account.
 * Shows all journal entry lines with running balance,
 * similar to QuickBooks account register / bank register.
 */

import { useState, useCallback, useMemo, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ArrowLeft, ArrowRight, Search, FileText, Loader2, Calendar, BookOpen, List } from "lucide-react";
import { useAccounts } from "@/hooks/useAccounts";
import { useGeneralLedger } from "@/hooks/useGeneralLedger";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { format, startOfYear, endOfMonth, subYears } from "date-fns";
import { cn } from "@/lib/utils";
import type { ExportConfig, ExportColumn, ExportRow } from "@/services/reports/ReportExportService";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";
import { ReportFilterProvider, useReportFilters } from "@/contexts/ReportFilterContext";

function AccountRegisterInner() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const accountId = searchParams.get("account_id") || "";
  const now = new Date();

  const urlDateFrom = searchParams.get("date_from");
  const urlDateTo = searchParams.get("date_to");
  const [dateFrom, setDateFromState] = useState(urlDateFrom || format(startOfYear(now), "yyyy-MM-dd"));
  const [dateTo, setDateToState] = useState(urlDateTo || format(endOfMonth(now), "yyyy-MM-dd"));

  // Sync date state to URL so they survive account switches / refresh / share.
  const updateParams = useCallback((updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const setDateFrom = useCallback((v: string) => {
    setDateFromState(v);
    updateParams({ date_from: v });
  }, [updateParams]);
  const setDateTo = useCallback((v: string) => {
    setDateToState(v);
    updateParams({ date_to: v });
  }, [updateParams]);

  const switchAccount = useCallback((newId: string) => {
    if (!newId || newId === accountId) return;
    updateParams({ account_id: newId });
  }, [accountId, updateParams]);
  const [searchQuery, setSearchQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSource, setDrawerSource] = useState<{ type: string | null; id: string | null }>({ type: null, id: null });
  const [openingBalanceJEId, setOpeningBalanceJEId] = useState<string | null>(null);
  const { accounts } = useAccounts();
  const account = accounts.find(a => a.id === accountId);
  const { formatCurrency, baseCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { filters } = useReportFilters();

  // Siblings = same account_type, active, sorted by code, for prev/next stepping.
  const siblings = useMemo(() => {
    if (!account) return [] as typeof accounts;
    return accounts
      .filter(a => a.is_active && a.account_type === account.account_type)
      .sort((a, b) => (a.code || "").localeCompare(b.code || ""));
  }, [accounts, account]);
  const siblingIdx = useMemo(
    () => siblings.findIndex(a => a.id === accountId),
    [siblings, accountId]
  );
  const prevAccount = siblingIdx > 0 ? siblings[siblingIdx - 1] : null;
  const nextAccount = siblingIdx >= 0 && siblingIdx < siblings.length - 1 ? siblings[siblingIdx + 1] : null;

  // Resolve a migration-origin opening-balance JE for this account, if one exists.
  useEffect(() => {
    let cancelled = false;
    setOpeningBalanceJEId(null);
    // No company in context = no single set of books to read; the register
    // renders the consolidation gate instead, so skip the lookup entirely.
    if (!currentOrg?.id || !currentBusiness?.id || !accountId) return;
    (async () => {
      const { data } = await supabase
        .from("journal_entries")
        .select("id, journal_entry_lines!inner(account_id)")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("source_type", "migration")
        .eq("journal_entry_lines.account_id", accountId)
        .order("entry_date", { ascending: true })
        .limit(1);
      if (!cancelled && data && data.length > 0) {
        setOpeningBalanceJEId(data[0].id as string);
      }
    })();
    return () => { cancelled = true; };
  }, [currentOrg?.id, currentBusiness?.id, accountId]);

  const { data, isLoading, error } = useGeneralLedger({
    dateFrom,
    dateTo,
    accountIds: accountId ? [accountId] : undefined,
    includeZeroActivity: false,
    // Same branch dimension as the GL report / Trial Balance, so a
    // branch-scoped statement can be tied back to this register.
    branchId: filters.branchId,
  });

  const accountData = data?.accounts?.[0];
  const transactions = accountData?.transactions || [];

  // Filter transactions by search. The running balance is a LEDGER property
  // (computed once in `useGeneralLedger` over the full period), never
  // recomputed over the visible subset — otherwise a search term would
  // silently produce partial cumulative balances.
  const transactionsWithBalance = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = q
      ? transactions.filter(t =>
          t.description?.toLowerCase().includes(q) ||
          t.entry_number?.toLowerCase().includes(q)
        )
      : transactions;
    return visible.map(t => ({ ...t, runningBalance: t.running_balance }));
  }, [transactions, searchQuery]);


  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "date", header: "Date", width: 14 },
      { key: "entry", header: "Entry #", width: 14 },
      { key: "description", header: "Description", width: 30 },
      { key: "debit", header: "Debit", width: 16, format: "currency", align: "right" },
      { key: "credit", header: "Credit", width: 16, format: "currency", align: "right" },
      { key: "balance", header: "Balance", width: 16, format: "currency", align: "right" },
    ];

    const rows: ExportRow[] = transactionsWithBalance.map(t => ({
      date: t.entry_date ? format(new Date(t.entry_date), "yyyy-MM-dd") : "",
      entry: t.entry_number || "",
      description: t.description || "",
      debit: t.debit_amount || 0,
      credit: t.credit_amount || 0,
      balance: t.runningBalance,
    }));

    return {
      title: `Account Register: ${account?.code} - ${account?.name}`,
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns,
      rows,
      sheetName: "Account Register",
      currency: baseCurrency,
    };
  }, [transactionsWithBalance, account, dateFrom, dateTo, currentOrg, baseCurrency]);

  if (!accountId) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <FileText className="h-12 w-12 text-muted-foreground" />
        <p className="text-muted-foreground">No account selected. Please select an account from the Chart of Accounts.</p>
        <Button onClick={() => navigate("/finance/accounts")}>
          Go to Chart of Accounts
        </Button>
      </div>
    );
  }

  return (
    <ReportPageLayout
      title={account ? `${account.code} — ${account.name}` : "Account Register"}
      description={account ? `${account.account_type.charAt(0).toUpperCase() + account.account_type.slice(1)} account • ${account.detail_type || "General"}` : "Loading..."}
      isLoading={isLoading}
      error={error as Error | null}
      // A register with no movement is NOT empty when the account carries a
      // balance forward: "nil movement, balance b/f X" is itself the answer.
      isEmpty={
        !isLoading &&
        transactionsWithBalance.length === 0 &&
        (accountData?.opening_balance || 0) === 0 &&
        (accountData?.closing_balance || 0) === 0
      }
      emptyState={{
        kind: "no_data",
        title: "No activity on this account",
        message:
          "The account has no posted journal lines in the selected period and no balance carried forward. Widen the date range or check whether the entries are still in draft.",
      }}
      getExportConfig={getExportConfig}
      headerActions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-[280px]">
            <AccountCombobox
              accounts={accounts}
              value={accountId}
              onValueChange={switchAccount}
              placeholder="Switch account..."
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => prevAccount && switchAccount(prevAccount.id)}
            disabled={!prevAccount}
            title={prevAccount ? `Previous: ${prevAccount.code} ${prevAccount.name}` : "No previous account in category"}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => nextAccount && switchAccount(nextAccount.id)}
            disabled={!nextAccount}
            title={nextAccount ? `Next: ${nextAccount.code} ${nextAccount.name}` : "No next account in category"}
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/finance/reports/general-ledger?date_from=${dateFrom}&date_to=${dateTo}&account_ids=${accountId}`)}
            title="Open this account in the General Ledger report"
          >
            <BookOpen className="mr-2 h-4 w-4" />
            General Ledger
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate("/finance/accounts")}>
            <List className="mr-2 h-4 w-4" />
            Chart of Accounts
          </Button>
        </div>
      }
      filters={
        <div className="flex flex-wrap items-end gap-3">
          <ReportFilters
            dateMode="range"
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateFromChange={setDateFrom}
            onDateToChange={setDateTo}
          />
          <ReportBranchFilter reportKind="general_ledger" />
        </div>
      }
    >
      {/* Account Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Opening Balance</p>
            <p className="text-lg font-semibold">{formatCurrency(accountData?.opening_balance || 0)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Debits</p>
            <p className="text-lg font-semibold">{formatCurrency(accountData?.total_debits || 0)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Credits</p>
            <p className="text-lg font-semibold">{formatCurrency(accountData?.total_credits || 0)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Closing Balance</p>
            <p className="text-lg font-bold text-primary">{formatCurrency(accountData?.closing_balance || 0)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Search within register */}
      <div className="relative max-w-sm mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search transactions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Transaction Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">Date</TableHead>
                <TableHead className="w-[120px]">Entry #</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right w-[130px]">Debit</TableHead>
                <TableHead className="text-right w-[130px]">Credit</TableHead>
                <TableHead className="text-right w-[140px]">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Opening balance row */}
              <TableRow className="bg-muted/50 font-medium">
                <TableCell>{format(new Date(dateFrom), "MMM d, yyyy")}</TableCell>
                <TableCell />
                <TableCell>
                  Opening Balance
                  {openingBalanceJEId && (
                    <span className="ml-2 text-xs text-muted-foreground">(from migration)</span>
                  )}
                </TableCell>
                <TableCell />
                <TableCell />
                <TableCell className="text-right font-semibold">
                  {openingBalanceJEId ? (
                    <button
                      className="text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
                      onClick={() => {
                        setDrawerSource({ type: "journal_entry", id: openingBalanceJEId });
                        setDrawerOpen(true);
                      }}
                    >
                      {formatCurrency(accountData?.opening_balance || 0)}
                    </button>
                  ) : (
                    formatCurrency(accountData?.opening_balance || 0)
                  )}
                </TableCell>
              </TableRow>

              {transactionsWithBalance.map((txn, idx) => (
                <TableRow key={idx} className="hover:bg-muted/30">
                  <TableCell className="text-sm">
                    {txn.entry_date ? format(new Date(txn.entry_date), "MMM d, yyyy") : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {txn.source_type && txn.source_id ? (
                      <button
                        className="text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
                        onClick={() => {
                          setDrawerSource({ type: txn.source_type, id: txn.source_id });
                          setDrawerOpen(true);
                        }}
                      >{txn.entry_number || "—"}</button>
                    ) : txn.entry_number ? (
                      <button
                        className="text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
                        onClick={async () => {
                          // Resolve JE id from line id, then preview the JE.
                          const { data } = await supabase
                            .from("journal_entry_lines")
                            .select("journal_entry_id")
                            .eq("id", txn.id)
                            .maybeSingle();
                          if (data?.journal_entry_id) {
                            setDrawerSource({ type: "journal_entry", id: data.journal_entry_id });
                            setDrawerOpen(true);
                          } else {
                            navigate(`/finance/journal-entries`);
                          }
                        }}
                      >{txn.entry_number}</button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {txn.description || "—"}
                    {txn.reference && txn.source_type && txn.source_id ? (
                      <button
                        className="text-xs text-primary hover:underline ml-2"
                        onClick={() => {
                          setDrawerSource({ type: txn.source_type, id: txn.source_id });
                          setDrawerOpen(true);
                        }}
                      >
                        Ref: {txn.reference}
                      </button>
                    ) : txn.reference ? (
                      <span className="text-xs text-muted-foreground ml-2">Ref: {txn.reference}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {txn.debit_amount ? formatCurrency(txn.debit_amount) : ""}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {txn.credit_amount ? formatCurrency(txn.credit_amount) : ""}
                  </TableCell>
                  <TableCell className="text-right font-medium text-sm">
                    {formatCurrency(txn.runningBalance)}
                  </TableCell>
                </TableRow>
              ))}

              {/* Closing balance row */}
              <TableRow className="bg-muted/50 font-bold border-t-2">
                <TableCell>{format(new Date(dateTo), "MMM d, yyyy")}</TableCell>
                <TableCell />
                <TableCell>Closing Balance</TableCell>
                <TableCell className="text-right">{formatCurrency(accountData?.total_debits || 0)}</TableCell>
                <TableCell className="text-right">{formatCurrency(accountData?.total_credits || 0)}</TableCell>
                <TableCell className="text-right text-primary">
                  {formatCurrency(accountData?.closing_balance || 0)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center mt-2">
        Showing {transactionsWithBalance.length} of {transactions.length} transaction
        {transactions.length !== 1 ? "s" : ""} in period
        {searchQuery.trim()
          ? " — running balance stays the full-period ledger balance, not a subtotal of the filtered rows."
          : ""}
      </p>


      <TransactionPreviewDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        sourceType={drawerSource.type}
        sourceId={drawerSource.id}
      />
    </ReportPageLayout>
  );
}

export default function AccountRegister() {
  return (
    <CompanyScopeGate reportName="The account register">
      <ReportFilterProvider>
        <AccountRegisterInner />
      </ReportFilterProvider>
    </CompanyScopeGate>
  );
}

