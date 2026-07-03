/**
 * TransferReconcileSheet — enterprise side-rail replacement for the
 * legacy `TransferReconcileDialog` modal. Matches a bank transaction
 * as a transfer between the current bank account and another account.
 *
 * Behaviour ported verbatim: calls `reconcile_bank_transfer_atomic`,
 * fires `onSuccess`, surfaces normalized error messages via toast.
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
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { ArrowDownLeft, ArrowUpRight, ArrowRightLeft, Loader2 } from "lucide-react";
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
  const { accounts: bankAccounts } = useBankAccounts();
  const [destBankAccountId, setDestBankAccountId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!transaction) return null;

  const isCredit = transaction.transaction_type === "credit";
  const transactionAmount = Math.abs(transaction.amount);

  const otherAccounts =
    bankAccounts?.filter((a) => a.is_active && a.id !== transaction.bank_account_id) || [];

  const close = () => {
    onOpenChange(false);
    setDestBankAccountId("");
  };

  const handleTransfer = async () => {
    if (!destBankAccountId) return;
    setIsSubmitting(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.rpc("reconcile_bank_transfer_atomic", {
        _source_txn_id: transaction.id,
        _dest_bank_account_id: destBankAccountId,
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
              <Button onClick={handleTransfer} disabled={isSubmitting || !destBankAccountId}>
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
                {formatCurrency(transactionAmount)}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-2">
          <Label>{isCredit ? "Transfer From" : "Transfer To"}</Label>
          <Select value={destBankAccountId} onValueChange={setDestBankAccountId}>
            <SelectTrigger>
              <SelectValue placeholder="Select bank account" />
            </SelectTrigger>
            <SelectContent>
              {otherAccounts.map((acc) => (
                <SelectItem key={acc.id} value={acc.id}>
                  {acc.name} — {acc.bank_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {isCredit
              ? "DR this bank account, CR the source account"
              : "DR the destination account, CR this bank account"}
          </p>
        </div>
      </div>
    </DetailSheet>
  );
}

export default TransferReconcileSheet;
