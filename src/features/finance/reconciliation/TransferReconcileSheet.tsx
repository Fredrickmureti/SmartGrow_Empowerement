/**
 * TransferReconcileSheet — matches a bank transaction as a transfer between
 * the current bank account and another bank account.
 *
 * Currency contract (ADR 0136): the transaction is denominated in its bank
 * account's currency, read through `useBankMoney` — never a formatter default.
 * `reconcile_bank_transfer_atomic` refuses a cross-currency transfer
 * (`BANK_TRANSFER_CURRENCY_MISMATCH`), so the picker only offers accounts in
 * the same currency and says so when that leaves nothing to pick.
 *
 * Accounting behaviour is unchanged: the RPC remains the only writer.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import {
  DetailSheet,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { useBankMoney } from "@/hooks/useBankAccountCurrency";
import { supabase } from "@/integrations/supabase/client";
import { formatDate, cn } from "@/lib/utils";
import { ArrowDownLeft, ArrowUpRight, ArrowRightLeft, Loader2, Info } from "lucide-react";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

interface TransferReconcileSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: any;
  onSuccess?: () => void;
}

export function TransferReconcileSheet({
  open,
  onOpenChange,
  transaction,
  onSuccess,
}: TransferReconcileSheetProps) {
  const { accounts: bankAccounts, isLoadingAccounts, currencyOf, formatBankAmount } =
    useBankMoney();
  const [counterpartyAccountId, setCounterpartyAccountId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!transaction) return null;

  const isCredit = transaction.transaction_type === "credit";
  const transactionAmount = Math.abs(transaction.amount);
  const thisAccountId: string | undefined = transaction.bank_account_id;
  const thisAccount = bankAccounts?.find((a) => a.id === thisAccountId);
  const thisCurrency = currencyOf(thisAccountId);

  // Every other active account in this workspace…
  const otherAccounts =
    bankAccounts?.filter((a) => a.is_active && a.id !== thisAccountId) || [];
  // …narrowed to those the server would actually accept: same currency.
  // A null currency on either side cannot be proven compatible, so it is out.
  const eligibleAccounts = otherAccounts.filter(
    (a) => thisCurrency != null && (a.currency ?? null) === thisCurrency,
  );

  const selectedAccount = eligibleAccounts.find((a) => a.id === counterpartyAccountId);

  /**
   * The RPC posts, for a debit line: DR counterparty GL / CR this account's GL.
   * For a credit line: DR this account's GL / CR counterparty GL. The hint is
   * derived from that, and names the accounts actually chosen.
   */
  const thisLabel = thisAccount?.name ?? "this bank account";
  const otherLabel = selectedAccount?.name ?? "the other account";
  const postingHint = isCredit
    ? `Money in: debit ${thisLabel}, credit ${otherLabel}.`
    : `Money out: debit ${otherLabel}, credit ${thisLabel}.`;

  const close = () => {
    onOpenChange(false);
    setCounterpartyAccountId("");
  };

  const handleTransfer = async () => {
    if (!counterpartyAccountId) return;
    setIsSubmitting(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.rpc("reconcile_bank_transfer_atomic", {
        _source_txn_id: transaction.id,
        _dest_bank_account_id: counterpartyAccountId,
        _user_id: userData.user?.id || null,
      });
      if (error) throw error;
      toast.success("Bank transfer reconciled");
      close();
      onSuccess?.();
    } catch (error: any) {
      console.error("Transfer reconciliation failed:", error);
      toast.error(normalizeError(error).message || "Failed to reconcile transfer");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Explicit, distinguishable states — an empty result never looks like a
  // broken control.
  const emptyStateMessage = isLoadingAccounts
    ? "Loading bank accounts…"
    : otherAccounts.length === 0
      ? "No other active bank account exists in this workspace. Add a second bank account to record a transfer."
      : thisCurrency == null
        ? "This bank account has no currency set, so no transfer counterparty can be validated. Set the account currency first."
        : eligibleAccounts.length === 0
          ? `No other active bank account is held in ${thisCurrency}. Cross-currency transfers are not supported — they need an FX entry.`
          : null;

  return (
    <DetailSheet
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <ArrowRightLeft className="h-4 w-4 text-primary" />
          Record bank transfer
        </span>
      }
      description="Match this transaction as a transfer between your bank accounts."
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button variant="outline" onClick={close} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                onClick={handleTransfer}
                disabled={isSubmitting || !counterpartyAccountId}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Reconcile transfer
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <div className="space-y-4">
        <Card className="bg-muted/40">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                {isCredit ? (
                  <ArrowDownLeft className="mt-0.5 h-5 w-5 text-green-500" />
                ) : (
                  <ArrowUpRight className="mt-0.5 h-5 w-5 text-destructive" />
                )}
                <div>
                  <p className="text-sm font-medium">{transaction.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(transaction.transaction_date)}
                    {thisAccount ? ` · ${thisAccount.name}` : ""}
                  </p>
                </div>
              </div>
              <div
                className={cn(
                  "text-lg font-bold tabular-nums",
                  isCredit ? "text-green-600" : "text-destructive",
                )}
              >
                {isCredit ? "+" : "-"}
                {formatBankAmount(transactionAmount, thisAccountId)}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-2">
          <Label>{isCredit ? "Transfer from" : "Transfer to"}</Label>

          {emptyStateMessage ? (
            <div className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              {isLoadingAccounts ? (
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              ) : (
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span>{emptyStateMessage}</span>
            </div>
          ) : (
            <>
              <Select value={counterpartyAccountId} onValueChange={setCounterpartyAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select bank account" />
                </SelectTrigger>
                <SelectContent>
                  {eligibleAccounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      {acc.name}
                      {acc.bank_name ? ` — ${acc.bank_name}` : ""}
                      {acc.currency ? ` · ${acc.currency}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{postingHint}</p>
            </>
          )}
        </div>
      </div>
    </DetailSheet>
  );
}

export default TransferReconcileSheet;
