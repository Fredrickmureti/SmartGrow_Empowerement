/**
 * General Ledger Page
 * 
 * Detailed transaction history for all accounts with export,
 * drill-down, and the standard ReportPageLayout.
 */

import { useState, useCallback, useEffect } from "react";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { TransactionPreviewDrawer } from "@/components/finance/TransactionPreviewDrawer";
import { useGeneralLedger } from "@/hooks/useGeneralLedger";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { cn } from "@/lib/utils";
import type { ExportConfig, ExportColumn, ExportRow } from "@/services/reports/ReportExportService";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";

function GeneralLedgerInner() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const now = new Date();
  const { filters } = useReportFilters();
  const [dateFrom, setDateFrom] = useState(searchParams.get("date_from") || filters.dateFrom || format(startOfMonth(now), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(searchParams.get("date_to") || filters.dateTo || format(endOfMonth(now), "yyyy-MM-dd"));
  const [selectedAccountId, setSelectedAccountId] = useState<string>(searchParams.get("account_id") || "all");
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSource, setDrawerSource] = useState<{ type: string | null; id: string | null }>({ type: null, id: null });

  // Auto-select account from URL params (e.g., from CoA "View Register" action)
  useEffect(() => {
    const accountId = searchParams.get("account_id");
    if (accountId) {
      setSelectedAccountId(accountId);
      // Auto-expand the account to show transactions immediately
      setExpandedAccounts(new Set([accountId]));
    }
  }, [searchParams]);

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

  const toggleAccount = (accountId: string) => {
    const newExpanded = new Set(expandedAccounts);
    if (newExpanded.has(accountId)) newExpanded.delete(accountId);
    else newExpanded.add(accountId);
    setExpandedAccounts(newExpanded);
  };

  const expandAll = () => setExpandedAccounts(new Set(data?.accounts.map((a) => a.account_id) || []));
  const collapseAll = () => setExpandedAccounts(new Set());

  const getExportConfig = useCallback((): ExportConfig => {
    const columns: ExportColumn[] = [
      { key: "date", header: "Date", width: 14 },
      { key: "entry", header: "Entry #", width: 14 },
      { key: "description", header: "Description", width: 30 },
      { key: "debit", header: "Debit", width: 16, format: "currency", align: "right" },
      { key: "credit", header: "Credit", width: 16, format: "currency", align: "right" },
      { key: "balance", header: "Balance", width: 16, format: "currency", align: "right" },
    ];

    const rows: ExportRow[] = [];
    for (const account of data?.accounts || []) {
      // Account header
      rows.push({
        date: "",
        entry: "",
        description: `${account.account_code} - ${account.account_name}`,
        debit: null,
        credit: null,
        balance: null,
        _isHeader: true,
      });

      // Opening balance
      rows.push({
        date: "",
        entry: "",
        description: "Opening Balance",
        debit: null,
        credit: null,
        balance: account.opening_balance,
      });

      // Transactions
      for (const txn of account.transactions) {
        rows.push({
          date: format(new Date(txn.entry_date), "yyyy-MM-dd"),
          entry: txn.entry_number,
          description: txn.description,
          debit: txn.debit_amount || null,
          credit: txn.credit_amount || null,
          balance: txn.running_balance,
        });
      }

      // Total
      rows.push({
        date: "",
        entry: "",
        description: "Total Movement",
        debit: account.total_debits,
        credit: account.total_credits,
        balance: account.closing_balance,
        _isSubtotal: true,
      });
    }

    // Grand total
    rows.push({
      date: "",
      entry: "",
      description: "GRAND TOTAL",
      debit: data?.grandTotals.debits || 0,
      credit: data?.grandTotals.credits || 0,
      balance: null,
      _isGrandTotal: true,
    });

    return {
      title: "General Ledger",
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns,
      rows,
      sheetName: "General Ledger",
      currency: baseCurrency,
    };
  }, [data, dateFrom, dateTo, currentOrg, baseCurrency]);

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
          <div className="flex gap-2 pb-0.5">
            <Button variant="ghost" size="sm" onClick={expandAll}>Expand All</Button>
            <Button variant="ghost" size="sm" onClick={collapseAll}>Collapse All</Button>
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

      {/* Account Ledgers */}
      <div className="space-y-4">
        {data?.accounts.map((account) => {
          const isExpanded = expandedAccounts.has(account.account_id);
          return (
            <Card key={account.account_id}>
              <Collapsible open={isExpanded} onOpenChange={() => toggleAccount(account.account_id)}>
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        {isExpanded ? <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" /> : <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />}
                        <div className="min-w-0 flex-1">
                          <CardTitle className="text-base flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-mono text-sm text-muted-foreground">{account.account_code}</span>
                            <span className="break-words">{account.account_name}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-xs text-primary hover:underline px-1.5"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate(`/finance/accounts/register?account_id=${account.account_id}`);
                              }}
                            >
                              View Register
                            </Button>
                          </CardTitle>
                          <CardDescription>{account.transactions.length} transactions</CardDescription>
                        </div>
                      </div>
                      <div className="flex items-baseline justify-between gap-3 sm:flex-col sm:items-end sm:justify-start sm:text-right shrink-0 pl-8 sm:pl-0">
                        <p className="text-sm text-muted-foreground">Closing Balance</p>
                        <p className={cn("font-bold tabular-nums break-all sm:break-normal", account.closing_balance >= 0 ? "text-foreground" : "text-destructive")}>
                          {formatCurrency(account.closing_balance, baseCurrency)}
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[100px]">Date</TableHead>
                            <TableHead className="w-[100px]">Entry #</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead className="text-right">Debit</TableHead>
                            <TableHead className="text-right">Credit</TableHead>
                            <TableHead className="text-right">Balance</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          <TableRow className="bg-muted/30">
                            <TableCell colSpan={5} className="font-medium">Opening Balance</TableCell>
                            <TableCell className="text-right font-medium">
                              {formatCurrency(account.opening_balance, baseCurrency)}
                            </TableCell>
                          </TableRow>
                          {account.transactions.map((txn) => (
                            <TableRow key={txn.id}>
                              <TableCell className="text-sm">{format(new Date(txn.entry_date), "MMM d, yyyy")}</TableCell>
                              <TableCell className="font-mono text-sm">
                                {txn.source_type && txn.source_id ? (
                                  <button
                                    className="text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDrawerSource({ type: txn.source_type!, id: txn.source_id! });
                                      setDrawerOpen(true);
                                    }}
                                  >{txn.entry_number}</button>
                                ) : (
                                  <button
                                    className="text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      // Resolve JE id from the line id, then preview the JE.
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
                                )}
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <span>{txn.description}</span>
                                  {txn.reference && <span className="text-xs text-muted-foreground">(Ref: {txn.reference})</span>}
                                  {txn.source_type && txn.source_id && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-5 w-5"
                                      title={`View ${txn.source_type}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setDrawerSource({ type: txn.source_type!, id: txn.source_id! });
                                        setDrawerOpen(true);
                                      }}
                                    >
                                      <ExternalLink className="h-3 w-3" />
                                    </Button>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-right">{txn.debit_amount > 0 ? formatCurrency(txn.debit_amount, baseCurrency) : "—"}</TableCell>
                              <TableCell className="text-right">{txn.credit_amount > 0 ? formatCurrency(txn.credit_amount, baseCurrency) : "—"}</TableCell>
                              <TableCell className="text-right font-medium">{formatCurrency(txn.running_balance, baseCurrency)}</TableCell>
                            </TableRow>
                          ))}
                          <TableRow className="bg-muted/30 font-medium">
                            <TableCell colSpan={3}>Total Movement</TableCell>
                            <TableCell className="text-right">{formatCurrency(account.total_debits, baseCurrency)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(account.total_credits, baseCurrency)}</TableCell>
                            <TableCell className="text-right font-bold">{formatCurrency(account.closing_balance, baseCurrency)}</TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          );
        })}
      </div>

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
