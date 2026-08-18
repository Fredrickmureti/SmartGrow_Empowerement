import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useBankAccounts, resolveBankAccountBalance } from "@/hooks/useBankAccounts";
import { useBankTransactions } from "@/hooks/useBankTransactions";
import { useCurrency } from "@/hooks/useCurrency";
import { useAccounts } from "@/hooks/useAccounts";
import { useAccountBalances } from "@/hooks/useAccountBalances";
import { useNavigate } from "react-router-dom";
import { Building2, ArrowRight, AlertCircle, Loader2 } from "lucide-react";

export function BankBalanceWidget() {
  const { accounts: bankAccounts, isLoading } = useBankAccounts();
  const { stats } = useBankTransactions();
  const { formatCurrency } = useCurrency();
  const { accounts: glAccounts } = useAccounts();
  const { getEffectiveBalance } = useAccountBalances();
  const navigate = useNavigate();

  // Derive GL balance for bank accounts that have a linked GL account
  const getGLBalance = (bankAccount: typeof bankAccounts[0]) => {
    if (bankAccount.account_id) {
      const glAccount = glAccounts.find(a => a.id === bankAccount.account_id);
      if (glAccount) {
        return getEffectiveBalance(glAccount.id, glAccount.opening_balance || 0);
      }
    }
    // No GL link: fall back to the server-derived statement position.
    return resolveBankAccountBalance(bankAccount)?.amount ?? 0;
  };

  const activeAccounts = bankAccounts?.filter(acc => acc.is_active) || [];
  const totalBalance = activeAccounts.reduce((sum, acc) => sum + getGLBalance(acc), 0);
  const unreconciledCount = stats?.unreconciledCount || 0;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (activeAccounts.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Building2 className="h-4 w-4 sm:h-5 sm:w-5" />
            Banking
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4">
            <Building2 className="h-8 w-8 sm:h-10 sm:w-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-xs sm:text-sm text-muted-foreground mb-4">
              Add a bank account to import statements and track transactions
            </p>
            <Button onClick={() => navigate("/finance/banking")} size="sm" className="text-xs sm:text-sm h-8 sm:h-9">
              Add Bank Account
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-col xs:flex-row xs:items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Building2 className="h-4 w-4 sm:h-5 sm:w-5" />
              Bank Balances
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">
              {activeAccounts.length} connected account{activeAccounts.length !== 1 ? 's' : ''}
            </CardDescription>
          </div>
          {unreconciledCount > 0 && (
            <Badge variant="secondary" className="bg-amber-100 text-amber-800 text-xs w-fit">
              <AlertCircle className="h-3 w-3 mr-1" />
              {unreconciledCount} to reconcile
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 sm:space-y-4">
        {/* Total Balance */}
        <div className="p-3 sm:p-4 rounded-lg bg-primary/5 border border-primary/10">
          <p className="text-xs sm:text-sm text-muted-foreground">Total Balance</p>
          <p className="text-xl sm:text-2xl font-bold break-all">{formatCurrency(totalBalance)}</p>
        </div>

        {/* Account List */}
        <div className="space-y-2">
          {activeAccounts.slice(0, 3).map((account) => {
            const providerLogo = (account as any).platform_bank_providers?.logo_url;
            
            return (
              <div key={account.id} className="flex items-center justify-between gap-2 py-2">
                <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                  <div className="h-7 w-7 sm:h-8 sm:w-8 rounded-md bg-muted flex items-center justify-center overflow-hidden flex-shrink-0">
                    {providerLogo ? (
                      <img 
                        src={providerLogo} 
                        alt={account.bank_name || "Bank"}
                        className="h-full w-full object-contain"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                          const fallback = e.currentTarget.nextElementSibling as HTMLElement;
                          if (fallback) fallback.style.display = 'flex';
                        }}
                      />
                    ) : null}
                    <Building2 className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${providerLogo ? 'hidden' : ''}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs sm:text-sm font-medium truncate">{account.name}</p>
                    <p className="text-[10px] sm:text-xs text-muted-foreground truncate">{account.bank_name}</p>
                  </div>
                </div>
                <p className="font-medium text-xs sm:text-sm flex-shrink-0">
                  {formatCurrency(getGLBalance(account), account.currency || undefined)}
                </p>
              </div>
            );
          })}
        </div>

        {activeAccounts.length > 3 && (
          <p className="text-xs text-muted-foreground text-center">
            +{activeAccounts.length - 3} more account{activeAccounts.length - 3 !== 1 ? 's' : ''}
          </p>
        )}

        <Button 
          variant="outline" 
          className="w-full text-xs sm:text-sm h-9 sm:h-10" 
          onClick={() => navigate("/finance/banking")}
        >
          View All Banking
          <ArrowRight className="h-3.5 w-3.5 sm:h-4 sm:w-4 ml-2" />
        </Button>
      </CardContent>
    </Card>
  );
}
