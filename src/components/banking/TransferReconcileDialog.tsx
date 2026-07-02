import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
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
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { ArrowDownLeft, ArrowUpRight, ArrowRightLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

interface TransferReconcileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction: any;
  onSuccess?: () => void;
}

export function TransferReconcileDialog({
  open,
  onOpenChange,
  transaction,
  onSuccess,
}: TransferReconcileDialogProps) {
  const { accounts: bankAccounts } = useBankAccounts();
  const [destBankAccountId, setDestBankAccountId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!transaction) return null;

  const isCredit = transaction.transaction_type === "credit";
  const transactionAmount = Math.abs(transaction.amount);

  // Filter out the source account
  const otherAccounts = bankAccounts?.filter(
    a => a.is_active && a.id !== transaction.bank_account_id
  ) || [];

  const handleTransfer = async () => {
    if (!destBankAccountId) return;
    setIsSubmitting(true);
    try {
      const { data: userData } = await supabase.auth.getUser();

      const { data, error } = await supabase.rpc("reconcile_bank_transfer_atomic", {
        _source_txn_id: transaction.id,
        _dest_bank_account_id: destBankAccountId,
        _user_id: userData.user?.id || null,
      });

      if (error) throw error;

      toast.success("Bank transfer reconciled");
      onOpenChange(false);
      setDestBankAccountId("");
      onSuccess?.();
    } catch (error: any) {
      console.error("Transfer reconciliation failed:", error);
      toast.error(normalizeError(error).message || "Failed to reconcile transfer");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-primary" />
            Record Bank Transfer
          </DialogTitle>
          <DialogDescription>
            Match this transaction as a transfer between your bank accounts.
          </DialogDescription>
        </DialogHeader>

        <Card className="bg-muted/50">
          <CardContent className="pt-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-3">
                {isCredit ? (
                  <ArrowDownLeft className="h-5 w-5 text-green-500 mt-0.5" />
                ) : (
                  <ArrowUpRight className="h-5 w-5 text-destructive mt-0.5" />
                )}
                <div>
                  <p className="font-medium text-sm">{transaction.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(transaction.transaction_date)}
                  </p>
                </div>
              </div>
              <div className={cn(
                "text-lg font-bold",
                isCredit ? "text-green-600" : "text-destructive"
              )}>
                {isCredit ? "+" : "-"}{formatCurrency(transactionAmount)}
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
              {otherAccounts.map(acc => (
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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleTransfer} disabled={isSubmitting || !destBankAccountId}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reconcile Transfer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
