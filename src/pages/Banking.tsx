import { useState, useEffect } from "react";
import { ReturnToMigrationBanner } from "@/components/migration/ReturnToMigrationBanner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBankAccounts, resolveBankAccountBalance } from "@/hooks/useBankAccounts";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { BankingLoadError } from "@/components/banking/BankingLoadError";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFx } from "@/hooks/useTenantFx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { BankAccountCard } from "@/components/banking/BankAccountCard";
// ImportTransactionsDialog removed — import is now a routed WizardShell at /finance/banking/import.
// BankAccountSheet removed — create/edit are routed pages at
// /finance/banking/accounts/new and /finance/banking/accounts/:id/edit.
import { TransactionsList } from "@/components/banking/TransactionsList";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { Plus, Building2, RefreshCw, ArrowUpDown, AlertCircle, FileUp } from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";

function formatCurrencyValue(amount: number, currencyCode: string = "USD") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode }).format(amount);
}

export default function Banking() {
  // Bank-account create/edit are routed full pages. Legacy deep links
  // (`?action=create`, `?sheet=account`, `?sheet=account&id=…`) are
  // normalised to the new routes so external launchers keep working.
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("action") === "create" || searchParams.get("sheet") === "account") {
      const id = searchParams.get("id");
      const next = new URLSearchParams(searchParams);
      next.delete("action");
      next.delete("sheet");
      next.delete("id");
      setSearchParams(next, { replace: true });
      navigate(id ? `/finance/banking/accounts/${id}/edit` : "/finance/banking/accounts/new");
    }
  }, [searchParams, setSearchParams, navigate]);
  const openConnectSheet = () => navigate("/finance/banking/accounts/new");
  const openEditSheet = (accountId: string) =>
    navigate(`/finance/banking/accounts/${accountId}/edit`);
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  // Phase 7 — the cash position is stated *as at a date*, never "now".
  // The reconciliation statement is always as of a chosen date; if the
  // dashboard silently asked the server for CURRENT_DATE the two surfaces
  // could disagree about the same account purely through date drift.
  const [asOf, setAsOf] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const { accounts: bankAccounts, isLoading: accountsLoading, loadError: accountsError, refetch: refetchAccounts, syncTransactions, isSaving: isSyncing, deleteAccount, canManage } = useBankAccounts({ asOf });
  const scope = useFinanceScope();
  const { transactions, isLoading: transactionsLoading, loadError: transactionsError, fetchTransactions, stats } = useBankTransactions();
  const fx = useTenantFx();
  const baseCurrency = currentBusiness?.base_currency ?? null;

  const handleDeleteAccount = async (accountId: string) => {
    await deleteAccount(accountId);
  };

  // Currency-aware aggregation over the ONE derived position.
  //
  // Phase 6: this screen performs no balance arithmetic of its own. Each
  // account's figure comes from `bank_account_positions()` through
  // `resolveBankAccountBalance` — the same projection the account cards and
  // the reconciliation statement read — so the dashboard cannot state a
  // different cash position from the reports. The previous code added
  // `accounts.opening_balance` to the posted-JE movement, which double counted
  // an opening balance that had itself been posted as a journal entry, and it
  // ignored the shared-control-account case entirely.
  //
  // An account whose balance does not resolve (no GL link and no statement
  // line, or a control account shared by several bank accounts) is NOT counted
  // as zero. It is excluded and reported, because a total that silently
  // swallows an unknown is worse than no total.
  const activeAccounts = bankAccounts?.filter(acc => acc.is_active) || [];

  const unresolvedAccounts = activeAccounts.filter(
    (acc) => resolveBankAccountBalance(acc) === null,
  );

  const balanceByCurrency: Record<string, number> = (() => {
    const out: Record<string, number> = {};
    for (const acc of activeAccounts) {
      const resolved = resolveBankAccountBalance(acc);
      if (!resolved) continue;
      const ccy = (acc.currency || baseCurrency || "").toUpperCase();
      if (!ccy) continue;
      out[ccy] = (out[ccy] ?? 0) + resolved.amount;
    }
    return out;
  })();

  // Each currency subtotal is converted to the base currency through the one
  // FX resolver. A missing rate is an absence (ADR-0136): we refuse the total
  // rather than showing a number built on an assumed 1.0.
  const fxBreakdown = baseCurrency
    ? Object.entries(balanceByCurrency).map(([ccy, amount]) => {
        const converted = ccy === baseCurrency.toUpperCase()
          ? amount
          : fx.convert(amount, ccy, baseCurrency);
        const rate = ccy === baseCurrency.toUpperCase() ? 1 : fx.rate(ccy, baseCurrency);
        return { ccy, amount, converted, rate };
      })
    : [];

  const missingFxCurrencies = fxBreakdown
    .filter(b => b.converted === null)
    .map(b => b.ccy);
  const totalBalanceBase = baseCurrency && missingFxCurrencies.length === 0
    ? fxBreakdown.reduce((s, b) => s + (b.converted ?? 0), 0)
    : null;

  const unreconciledCount = stats?.unreconciledCount || 0;

  // Per-account stats: unreconciled counts and last reconciliation dates
  const [perAccountStats, setPerAccountStats] = useState<Record<string, { unreconciledCount: number; lastReconciledDate: string | null }>>({});
  
  useEffect(() => {
    if (!bankAccounts?.length) return;
    const fetchPerAccountStats = async () => {
      const accountIds = bankAccounts.map(a => a.id);
      // Fetch unreconciled counts per account
      const { data: unreconData } = await supabase
        .from("bank_transactions")
        .select("bank_account_id")
        .in("bank_account_id", accountIds)
        .eq("is_reconciled", false);
      
      // Fetch last completed session per account
      const { data: sessionData } = await supabase
        .from("bank_reconciliation_sessions")
        .select("bank_account_id, completed_at")
        .in("bank_account_id", accountIds)
        .eq("status", "completed")
        .order("completed_at", { ascending: false });
      
      const statsMap: Record<string, { unreconciledCount: number; lastReconciledDate: string | null }> = {};
      for (const id of accountIds) {
        const count = unreconData?.filter(t => t.bank_account_id === id).length ?? 0;
        const lastSession = sessionData?.find(s => s.bank_account_id === id);
        statsMap[id] = { unreconciledCount: count, lastReconciledDate: lastSession?.completed_at || null };
      }
      setPerAccountStats(statsMap);
    };
    fetchPerAccountStats();
  }, [bankAccounts]);

  const handleSyncAll = async () => {
    for (const account of activeAccounts) {
      await syncTransactions(account.id);
    }
  };

  return (
    <>
      <ReturnToMigrationBanner />
      <div className="space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="page-header">
          <div className="flex items-center gap-2 flex-wrap">
            <div>
              <h1 className="page-title">Banking</h1>
              <p className="text-sm sm:text-base text-muted-foreground">
                Manage bank accounts, import statements, and track transactions
              </p>
            </div>
            <FinanceScopeBadge />
            <div className="flex items-center gap-2">
              <label htmlFor="banking-as-of" className="text-xs text-muted-foreground">
                As at
              </label>
              <Input
                id="banking-as-of"
                type="date"
                value={asOf}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setAsOf(e.target.value || new Date().toISOString().slice(0, 10))}
                className="h-8 w-[9.5rem]"
              />
            </div>
            <RefreshButton
              queryKeyPrefixes={[
                ['bank-accounts', currentOrg?.id || ""] as const,
                queryKeys.bankTransactions.all(currentOrg?.id || ""),
                queryKeys.reports.cashFlow(currentOrg?.id || ""),
              ]}
              tooltip="Refresh banking data"
            />
          </div>
          <div className="action-buttons w-full sm:w-auto">
            <PermissionGate permission="manageFinancials">
              {activeAccounts.length > 0 && (
                <>
                  <Button asChild variant="outline" className="flex-1 sm:flex-none">
                    <Link to="/finance/banking/import">
                      <FileUp className="mr-2 h-4 w-4" />
                      Import Statement
                    </Link>
                  </Button>
                  <Button variant="outline"
                    onClick={handleSyncAll}
                    disabled={isSyncing}
                    className="flex-1 sm:flex-none"
                  >
                    <RefreshCw className={`mr-2 h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
                    Sync All
                  </Button>
                </>
              )}
              {canManage && (
                <Button onClick={openConnectSheet} className="flex-1 sm:flex-none">
                  <Plus className="mr-2 h-4 w-4" />
                  Add Bank Account
                </Button>
              )}
            </PermissionGate>
          </div>
        </div>


        {/* Summary Cards */}
        <div className="stats-grid">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Balance</CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {!baseCurrency || fx.isLoading ? (
                <Skeleton className="h-8 w-32" />
              ) : missingFxCurrencies.length > 0 ? (
                <>
                  <div className="text-2xl font-bold text-muted-foreground">—</div>
                  <p className="text-xs text-amber-600">
                    Missing FX rate for {missingFxCurrencies.join(", ")}.{" "}
                    <Link to="/settings/company" className="underline">
                      Configure rates
                    </Link>
                  </p>
                </>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="text-2xl font-bold cursor-help">
                      {formatCurrencyValue(totalBalanceBase ?? 0, baseCurrency)}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <div className="space-y-1 text-xs">
                      <div className="font-medium">Per-currency breakdown</div>
                      {fxBreakdown.map(b => (
                        <div key={b.ccy} className="flex justify-between gap-3">
                          <span>{formatCurrencyValue(b.amount, b.ccy)}</span>
                          <span className="text-muted-foreground">
                            {b.ccy === baseCurrency.toUpperCase()
                              ? "base"
                              : `× ${b.rate?.toFixed(4)} → ${formatCurrencyValue(b.converted ?? 0, baseCurrency)}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
              <p className="text-xs text-muted-foreground">
                As at {asOf} · derived position across {activeAccounts.length - unresolvedAccounts.length} of {activeAccounts.length} account{activeAccounts.length !== 1 ? 's' : ''}
                {fxBreakdown.length > 1 ? ` · ${fxBreakdown.length} currencies` : ""}
                {" · "}
                <span className="font-medium">{scope.scopeLabel}</span>
              </p>
              {unresolvedAccounts.length > 0 && (
                <p className="text-xs text-amber-600">
                  {unresolvedAccounts.length} account
                  {unresolvedAccounts.length !== 1 ? "s are" : " is"} excluded: no linked
                  GL account, a control account shared with another bank account, or no
                  imported statement line.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Connected Banks</CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{activeAccounts.length}</div>
              <p className="text-xs text-muted-foreground">
                Active connections
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Transactions</CardTitle>
              <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{transactions?.length || 0}</div>
              <p className="text-xs text-muted-foreground">
                This month
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Unreconciled</CardTitle>
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{unreconciledCount}</div>
              {unreconciledCount > 0 && (
                <Link 
                  to="/finance/reconciliation" 
                  className="text-xs text-primary hover:underline"
                >
                  Reconcile now →
                </Link>
              )}
            </CardContent>
          </Card>
        </div>

        {/* No accounts alert */}
        {!accountsLoading && activeAccounts.length === 0 && (
          <Alert>
            <Building2 className="h-4 w-4" />
            <AlertDescription>
              No bank accounts connected yet. Connect a bank account to start syncing transactions automatically.
            </AlertDescription>
          </Alert>
        )}

        {/* Unlinked GL accounts warning */}
        {!accountsLoading && activeAccounts.length > 0 && (() => {
          const unlinkedCount = activeAccounts.filter(a => !a.account_id).length;
          return unlinkedCount > 0 ? (
            <Alert variant="destructive" className="border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300 [&>svg]:text-amber-600">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {unlinkedCount} bank account{unlinkedCount > 1 ? 's have' : ' has'} no linked GL account. Reconciliation and balance tracking require a GL link. Edit the account to add one.
              </AlertDescription>
            </Alert>
          ) : null;
        })()}

        {/* Main Content */}
        <Tabs defaultValue="accounts" className="space-y-4">
          <TabsList>
            <TabsTrigger value="accounts">Bank Accounts</TabsTrigger>
            <TabsTrigger value="transactions">
              Transactions
              {unreconciledCount > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {unreconciledCount}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="accounts" className="space-y-4">
            {accountsLoading ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {[1, 2, 3].map((i) => (
                  <Card key={i} className="h-48 animate-pulse bg-muted" />
                ))}
              </div>
            ) : accountsError ? (
              <BankingLoadError
                error={accountsError}
                what="bank accounts"
                onRetry={refetchAccounts}
              />
            ) : bankAccounts && bankAccounts.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {bankAccounts.map((account) => {
                  // The card resolves its own figure from `account.position`.
                  // Nothing here re-derives a balance, and the unreconciled
                  // count comes from the same projection so the card's two
                  // numbers share one `as_of`.
                  const acctStats = perAccountStats[account.id];
                    return (
                      <BankAccountCard
                        key={account.id}
                        account={account}
                        unreconciledCount={
                          account.position?.unreconciled_count ?? acctStats?.unreconciledCount
                        }
                        lastReconciledDate={acctStats?.lastReconciledDate}
                        onSync={() => syncTransactions(account.id)}
                        isSyncing={isSyncing}
                        onEdit={() => { if (canManage) openEditSheet(account.id); }}
                        onDelete={() => { if (canManage) handleDeleteAccount(account.id); }}
                      />
                  );
                })}
                {/* Add new account card — gated by finance.manage_bank_accounts */}
                {canManage && (
                  <Card
                    className="flex h-48 cursor-pointer items-center justify-center border-dashed hover:border-primary hover:bg-muted/50 transition-colors"
                    onClick={() => {
                      if (isReadOnly) {
                        openUpgradeModal("banking");
                      } else {
                        openConnectSheet();
                      }
                    }}
                  >
                    <div className="text-center">
                      <Plus className="mx-auto h-8 w-8 text-muted-foreground" />
                      <p className="mt-2 text-sm text-muted-foreground">Connect another bank</p>
                    </div>
                  </Card>
                )}
              </div>
            ) : (
              <Card className="flex h-64 items-center justify-center">
                <div className="text-center">
                  <Building2 className="mx-auto h-12 w-12 text-muted-foreground" />
                  <h3 className="mt-4 text-lg font-semibold">No bank accounts</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Add a bank account to start importing statements and tracking transactions
                  </p>
                  <PermissionGate permission="manageFinancials">
                    {canManage && (
                      <Button className="mt-4" onClick={openConnectSheet}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add Bank Account
                      </Button>
                    )}
                  </PermissionGate>
                </div>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="transactions">
            {transactionsError && !transactionsLoading ? (
              <BankingLoadError
                error={transactionsError}
                what="transactions"
                onRetry={() => fetchTransactions()}
              />
            ) : (
              <TransactionsList
                transactions={transactions || []}
                isLoading={transactionsLoading}
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
