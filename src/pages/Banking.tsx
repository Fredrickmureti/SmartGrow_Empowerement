import { useState, useEffect } from "react";
import { ReturnToMigrationBanner } from "@/components/migration/ReturnToMigrationBanner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { BankingLoadError } from "@/components/banking/BankingLoadError";
import { supabase } from "@/integrations/supabase/client";
import { useAccounts } from "@/hooks/useAccounts";
import { useAccountBalances } from "@/hooks/useAccountBalances";
import { useTenantFx } from "@/hooks/useTenantFx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
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
  const { accounts: bankAccounts, isLoading: accountsLoading, syncTransactions, isSaving: isSyncing, deleteAccount, canManage } = useBankAccounts();
  const scope = useFinanceScope();
  const { transactions, isLoading: transactionsLoading, stats } = useBankTransactions();
  const { accounts: glAccounts } = useAccounts();
  const { getEffectiveBalance } = useAccountBalances();
  const fx = useTenantFx();
  const baseCurrency = currentBusiness?.base_currency ?? null;

  const handleDeleteAccount = async (accountId: string) => {
    await deleteAccount(accountId);
  };

  // Currency-aware aggregation. Bank accounts may hold different currencies;
  // summing them as raw numbers (the previous behaviour) was an accounting
  // bug. Group by each bank account's `currency`, derive the GL-balance per
  // group from posted JE lines + opening balance (single source of truth),
  // then convert each subtotal to the company base currency via
  // platform_exchange_rates. If any required rate is missing we surface a
  // warning and refuse to display a misleading total — Odoo / Xero / QBO
  // standard.
  const balanceByCurrency: Record<string, number> = (() => {
    const out: Record<string, number> = {};
    if (!bankAccounts?.length || !glAccounts?.length) return out;
    const glById = new Map(glAccounts.map(a => [a.id, a]));
    for (const ba of bankAccounts) {
      if (!ba.account_id) continue;
      const gl = glById.get(ba.account_id);
      if (!gl) continue;
      const ccy = (ba.currency || baseCurrency || "").toUpperCase();
      if (!ccy) continue;
      const bal = getEffectiveBalance(gl.id, gl.opening_balance ?? 0);
      out[ccy] = (out[ccy] ?? 0) + bal;
    }
    return out;
  })();

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
  const activeAccounts = bankAccounts?.filter(acc => acc.is_active) || [];
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
                Book balance (GL-derived) across {activeAccounts.length} account{activeAccounts.length !== 1 ? 's' : ''}
                {fxBreakdown.length > 1 ? ` · ${fxBreakdown.length} currencies` : ""}
                {" · "}
                <span className="font-medium">{scope.scopeLabel}</span>
              </p>
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
            ) : bankAccounts && bankAccounts.length > 0 ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {bankAccounts.map((account) => {
                  // Derive GL balance for this account
                  const linkedGL = account.account_id ? glAccounts?.find(a => a.id === account.account_id) : null;
                  const glBalance = linkedGL?.current_balance ?? null;
                  const acctStats = perAccountStats[account.id];
                    return (
                      <BankAccountCard
                        key={account.id}
                        account={account}
                        glBalance={glBalance}
                        unreconciledCount={acctStats?.unreconciledCount}
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
            <TransactionsList 
              transactions={transactions || []} 
              isLoading={transactionsLoading}
            />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
