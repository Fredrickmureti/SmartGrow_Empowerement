import { useState, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { ReconciliationSession } from "@/hooks/useReconciliationSessions";
import { useBankTransactions, BankTransaction } from "@/hooks/useBankTransactions";
import { useReconciliationItems } from "@/hooks/useReconciliationItems";
import { useGLPosting } from "@/hooks/useGLPosting";
import { useCurrency } from "@/hooks/useCurrency";
import { toast } from "sonner";
import {
  CheckCircle2,
  XCircle,
  Search,
  ArrowDownLeft,
  ArrowUpRight,
  Loader2,
  Scale,
  DollarSign,
  Eraser,
} from "lucide-react";
import { formatDate, cn } from "@/lib/utils";

interface ReconciliationWorkspaceProps {
  session: ReconciliationSession;
  onComplete: (sessionId: string, clearedTransactionIds: string[], computedDifference?: number) => Promise<boolean>;
  onCancel: (sessionId: string) => Promise<boolean>;
  onUpdateBalance: (sessionId: string, balance: number) => Promise<void>;
}

export function ReconciliationWorkspace({
  session,
  onComplete,
  onCancel,
  onUpdateBalance,
}: ReconciliationWorkspaceProps) {
  const { formatCurrency } = useCurrency();
  const { postToGL } = useGLPosting();
  const { transactions, isLoading: txLoading } = useBankTransactions({ bankAccountId: session.bank_account_id });
  const { clearedIds, isLoading: itemsLoading, isSaving, toggleCleared, markAllReconciled } = useReconciliationItems(session.id);
  const [searchQuery, setSearchQuery] = useState("");
  const [isCompleting, setIsCompleting] = useState(false);
  const [isWritingOff, setIsWritingOff] = useState(false);
  const WRITE_OFF_THRESHOLD = 5.00;

  const isLoading = txLoading || itemsLoading;

  // Filter transactions: only those on or before statement date, not already reconciled in another session
  const eligibleTransactions = useMemo(() => {
    if (!transactions) return [];
    return transactions.filter(tx => {
      const txDate = new Date(tx.transaction_date);
      const stmtDate = new Date(session.statement_date);
      return txDate <= stmtDate;
    });
  }, [transactions, session.statement_date]);

  // Split into debits (checks/payments) and credits (deposits)
  const { debits, credits } = useMemo(() => {
    const filtered = eligibleTransactions.filter(tx => {
      if (!searchQuery) return true;
      return tx.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        tx.reference?.toLowerCase().includes(searchQuery.toLowerCase());
    });
    return {
      debits: filtered.filter(tx => tx.transaction_type === "debit"),
      credits: filtered.filter(tx => tx.transaction_type === "credit"),
    };
  }, [eligibleTransactions, searchQuery]);

  // Already reconciled transactions count as pre-cleared
  const isCleared = useCallback((tx: BankTransaction) => {
    return tx.is_reconciled || clearedIds.has(tx.id);
  }, [clearedIds]);

  const handleToggle = useCallback((txId: string, currentlyReconciled: boolean) => {
    if (currentlyReconciled) return; // Can't uncheck already-reconciled items
    toggleCleared(txId);
  }, [toggleCleared]);

  // Calculate cleared balance
  const clearedBalance = useMemo(() => {
    let total = session.opening_balance;
    for (const tx of eligibleTransactions) {
      if (isCleared(tx)) {
        total += tx.transaction_type === "credit" ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      }
    }
    // Add service charge / interest if configured
    total -= (session as any).service_charge_amount || 0;
    total += (session as any).interest_earned_amount || 0;
    return total;
  }, [eligibleTransactions, isCleared, session]);

  const difference = session.closing_balance - clearedBalance;
  const isBalanced = Math.abs(difference) < 0.01;

  // Counts
  const clearedDebitCount = debits.filter(tx => isCleared(tx)).length;
  const clearedCreditCount = credits.filter(tx => isCleared(tx)).length;
  const clearedDebitTotal = debits.filter(tx => isCleared(tx)).reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const clearedCreditTotal = credits.filter(tx => isCleared(tx)).reduce((s, tx) => s + Math.abs(tx.amount), 0);

  const canWriteOff = !isBalanced && Math.abs(difference) <= WRITE_OFF_THRESHOLD && Math.abs(difference) > 0.01;

  const handleWriteOff = async () => {
    if (!session.service_charge_account_id) {
      toast.error("No write-off account configured. Set a service charge account when starting reconciliation.");
      return;
    }
    setIsWritingOff(true);
    try {
      // Get bank GL account
      const { supabase } = await import("@/integrations/supabase/client");
      const { data: bankAccount } = await supabase
        .from("bank_accounts")
        .select("account_id")
        .eq("id", session.bank_account_id)
        .single();

      if (!bankAccount?.account_id) {
        toast.error("Bank account has no linked GL account");
        return;
      }

      const writeOffAmount = Math.abs(difference);
      // If difference > 0: statement shows more than books → DR Bank, CR Write-off (income)
      // If difference < 0: statement shows less than books → DR Write-off (expense), CR Bank
      const entries = difference > 0
        ? [
            { account_id: bankAccount.account_id, debit_amount: writeOffAmount, credit_amount: 0, description: "Reconciliation write-off" },
            { account_id: session.service_charge_account_id!, debit_amount: 0, credit_amount: writeOffAmount, description: "Reconciliation write-off" },
          ]
        : [
            { account_id: session.service_charge_account_id!, debit_amount: writeOffAmount, credit_amount: 0, description: "Reconciliation write-off" },
            { account_id: bankAccount.account_id, debit_amount: 0, credit_amount: writeOffAmount, description: "Reconciliation write-off" },
          ];

      await postToGL({
        source_type: "bank_recon",
        source_id: session.id,
        source_subtype: "writeoff",
        reference: `Recon-WO-${session.statement_date}`,
        memo: `Reconciliation write-off - ${formatCurrency(writeOffAmount)}`,
        entry_date: session.statement_date,
        entries,
      });
      toast.success(`Written off ${formatCurrency(writeOffAmount)} difference`);
      // Update the session balance to account for the write-off
      await onUpdateBalance(session.id, clearedBalance + difference);
    } catch (error) {
      console.error("Write-off failed:", error);
      toast.error("Failed to write off difference");
    } finally {
      setIsWritingOff(false);
    }
  };

  const handleFinish = async () => {
    setIsCompleting(true);
    try {
      await onUpdateBalance(session.id, clearedBalance);
      await markAllReconciled();
      await onComplete(session.id, Array.from(clearedIds), difference);
    } finally {
      setIsCompleting(false);
    }
  };

  const renderTransactionRow = (tx: BankTransaction) => {
    const cleared = isCleared(tx);
    const isPreReconciled = tx.is_reconciled;
    return (
      <div
        key={tx.id}
        className={cn(
          "flex items-center gap-3 py-2 px-3 rounded-md cursor-pointer transition-colors hover:bg-muted/50",
          cleared && "bg-primary/5",
          isPreReconciled && "opacity-60"
        )}
        onClick={() => handleToggle(tx.id, isPreReconciled)}
      >
        <Checkbox
          checked={cleared}
          disabled={isPreReconciled || isSaving}
          onCheckedChange={() => handleToggle(tx.id, isPreReconciled)}
          className="shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {formatDate(tx.transaction_date)}
            </span>
            {tx.reference && (
              <span className="text-xs font-mono text-muted-foreground">#{tx.reference}</span>
            )}
          </div>
          <p className="text-sm truncate">{tx.description}</p>
        </div>
        <span className={cn(
          "text-sm font-medium tabular-nums whitespace-nowrap",
          tx.transaction_type === "credit" ? "text-green-600" : "text-destructive"
        )}>
          {tx.transaction_type === "credit" ? "+" : "-"}
          {formatCurrency(Math.abs(tx.amount))}
        </span>
        {isPreReconciled && (
          <Badge variant="secondary" className="text-[10px] shrink-0">Prior</Badge>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Summary Header */}
      <Card className="border-primary/30">
        <CardContent className="pt-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Statement Date</p>
              <p className="font-medium text-sm">{formatDate(session.statement_date)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Beginning Balance</p>
              <p className="font-medium text-sm tabular-nums">{formatCurrency(session.opening_balance)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Statement Ending</p>
              <p className="font-medium text-sm tabular-nums">{formatCurrency(session.closing_balance)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Cleared Balance</p>
              <p className="font-medium text-sm tabular-nums">{formatCurrency(clearedBalance)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Difference</p>
              <p className={cn(
                "font-bold text-sm tabular-nums",
                isBalanced ? "text-green-600" : "text-destructive"
              )}>
                {formatCurrency(difference)}
              </p>
            </div>
          </div>

          {/* Service charge / Interest summary if present */}
          {(((session as any).service_charge_amount || 0) > 0 || ((session as any).interest_earned_amount || 0) > 0) && (
            <>
              <Separator className="my-3" />
              <div className="flex gap-6 text-xs">
                {((session as any).service_charge_amount || 0) > 0 && (
                  <div className="flex items-center gap-1">
                    <DollarSign className="h-3 w-3 text-destructive" />
                    <span className="text-muted-foreground">Service Charge:</span>
                    <span className="text-destructive font-medium">-{formatCurrency((session as any).service_charge_amount)}</span>
                  </div>
                )}
                {((session as any).interest_earned_amount || 0) > 0 && (
                  <div className="flex items-center gap-1">
                    <DollarSign className="h-3 w-3 text-green-600" />
                    <span className="text-muted-foreground">Interest Earned:</span>
                    <span className="text-green-600 font-medium">+{formatCurrency((session as any).interest_earned_amount)}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search transactions..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        /* Two-column layout: Checks/Payments | Deposits/Credits */
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Checks & Payments (Debits) */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ArrowUpRight className="h-4 w-4 text-destructive" />
                  Checks & Payments
                </CardTitle>
                <div className="text-xs text-muted-foreground">
                  {clearedDebitCount} of {debits.length} cleared
                  <span className="ml-2 font-medium text-destructive">-{formatCurrency(clearedDebitTotal)}</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <ScrollArea className="h-[400px]">
                <div className="space-y-1">
                  {debits.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">No payments found</p>
                  ) : (
                    debits.map(renderTransactionRow)
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Deposits & Credits */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ArrowDownLeft className="h-4 w-4 text-green-600" />
                  Deposits & Credits
                </CardTitle>
                <div className="text-xs text-muted-foreground">
                  {clearedCreditCount} of {credits.length} cleared
                  <span className="ml-2 font-medium text-green-600">+{formatCurrency(clearedCreditTotal)}</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <ScrollArea className="h-[400px]">
                <div className="space-y-1">
                  {credits.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">No deposits found</p>
                  ) : (
                    credits.map(renderTransactionRow)
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Action Bar */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {isBalanced ? (
                <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                  Balanced — Ready to finish
                </Badge>
              ) : (
                <Badge variant="outline" className="text-destructive border-destructive/30">
                  <XCircle className="mr-1 h-3 w-3" />
                  Difference: {formatCurrency(difference)}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => onCancel(session.id)}>
                Leave for Later
              </Button>
              {canWriteOff && (
                <Button
                  variant="outline"
                  onClick={handleWriteOff}
                  disabled={isWritingOff}
                >
                  {isWritingOff ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Eraser className="mr-2 h-4 w-4" />
                  )}
                  Write Off {formatCurrency(Math.abs(difference))}
                </Button>
              )}
              <Button
                onClick={handleFinish}
                disabled={!isBalanced || isCompleting}
              >
                {isCompleting ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Scale className="mr-2 h-4 w-4" />
                )}
                Finish Now
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
