import { useState, useMemo } from "react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useCreditNotes } from "@/hooks/useCreditNotes";
import { useCurrency } from "@/hooks/useCurrency";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowDown, ArrowUp, DollarSign, AlertCircle } from "lucide-react";
import { normalizeError } from "@/services/resilience";

interface ProcessRefundDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creditNoteId: string;
  creditNoteNumber: string;
  contactName: string;
  totalAmount: number;
  amountApplied: number;
  amountRefunded: number;
  currency?: string;
  onSuccess?: () => void;
}

export function ProcessRefundDialog({
  open,
  onOpenChange,
  creditNoteId,
  creditNoteNumber,
  contactName,
  totalAmount,
  amountApplied,
  amountRefunded,
  currency,
  onSuccess,
}: ProcessRefundDialogProps) {
  const { processRefund } = useCreditNotes();
  const { formatCurrency } = useCurrency();
  const { accounts } = useDefaultAccounts();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const availableForRefund = totalAmount - amountApplied - amountRefunded;

  const [refundAmount, setRefundAmount] = useState(availableForRefund);
  const [refundMethod, setRefundMethod] = useState<string>("cash");
  const [notes, setNotes] = useState("");

  // Reset when dialog opens
  useState(() => {
    setRefundAmount(availableForRefund);
    setRefundMethod("cash");
    setNotes("");
  });

  // Get payment accounts for refund
  const paymentAccountId = useMemo(() => {
    if (refundMethod === "cash") return accounts?.cash_account_id;
    if (refundMethod === "bank_transfer") return accounts?.bank_account_id;
    return accounts?.cash_account_id;
  }, [refundMethod, accounts]);

  const receivableAccountId = accounts?.accounts_receivable_id;

  const canSubmit = refundAmount > 0 && refundAmount <= availableForRefund && paymentAccountId && receivableAccountId;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      await processRefund(creditNoteId, refundAmount, refundMethod, paymentAccountId!, notes || undefined);
      toast({ title: `Refund of ${formatCurrency(refundAmount, currency)} processed for ${creditNoteNumber}` });
      onOpenChange(false);
      onSuccess?.();
    } catch (error: any) {
      toast({ title: "Refund failed", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <DollarSign className="h-5 w-5" />
          Process Refund
        </span>
      }
      description={<>Refund credit from <strong>{creditNoteNumber}</strong> to <strong>{contactName}</strong></>}
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={<Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>}
          trailing={
            <Button onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <DollarSign className="h-4 w-4 mr-2" />}
              Process Refund
            </Button>
          }
        />
      }
    >



        {/* Credit Note Summary */}
        <div className="grid grid-cols-3 gap-3 text-sm bg-muted/50 rounded-lg p-3">
          <div>
            <span className="text-muted-foreground text-xs block">Credit Total</span>
            <span className="font-semibold">{formatCurrency(totalAmount, currency)}</span>
          </div>
          <div>
            <span className="text-muted-foreground text-xs block">Applied</span>
            <span className="font-medium text-emerald-600">{formatCurrency(amountApplied, currency)}</span>
          </div>
          <div>
            <span className="text-muted-foreground text-xs block">Available for Refund</span>
            <span className="font-bold text-primary">{formatCurrency(availableForRefund, currency)}</span>
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Refund Amount *</Label>
            <Input
              type="number"
              step="0.01"
              min="0.01"
              max={availableForRefund}
              value={refundAmount}
              onChange={(e) => setRefundAmount(parseFloat(e.target.value) || 0)}
            />
            {refundAmount > availableForRefund && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" /> Cannot exceed available balance
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Refund Method *</Label>
            <Select value={refundMethod} onValueChange={setRefundMethod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                <SelectItem value="check">Check</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional refund notes..."
            />
          </div>
        </div>

        {/* Journal Entry Preview */}
        {canSubmit && (
          <>
            <Separator />
            <div className="text-sm">
              <h4 className="font-medium mb-2">Journal Entry Preview</h4>
              <div className="space-y-1 bg-muted/30 rounded-lg p-3 font-mono text-xs">
                <div className="flex justify-between">
                  <span className="flex items-center gap-2">
                    <ArrowUp className="h-3 w-3 text-red-500" />
                    Dr: Accounts Receivable
                  </span>
                  <span>{formatCurrency(refundAmount, currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="flex items-center gap-2">
                    <ArrowDown className="h-3 w-3 text-green-500" />
                    Cr: {refundMethod === "bank_transfer" ? "Bank Account" : "Cash"}
                  </span>
                  <span>{formatCurrency(refundAmount, currency)}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                This reverses the AR credit and records the cash outflow.
              </p>
            </div>
          </>
        )}

        {!paymentAccountId && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3 w-3" /> Missing default {refundMethod === "bank_transfer" ? "bank" : "cash"} account. Configure in Settings → Default Accounts.
          </p>
        )}

    </DetailSheet>

  );
}
