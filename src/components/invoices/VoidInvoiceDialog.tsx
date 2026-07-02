import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useTransactionReversal } from "@/hooks/useTransactionReversal";
import { useCurrency } from "@/hooks/useCurrency";
import { AlertTriangle, Loader2 } from "lucide-react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";

interface VoidInvoiceDialogProps {
  invoice: {
    id: string;
    invoice_number: string;
    total: number;
    amount_paid: number;
    status: string;
    currency?: string;
  } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function VoidInvoiceDialog({
  invoice,
  open,
  onOpenChange,
  onSuccess,
}: VoidInvoiceDialogProps) {
  const [reason, setReason] = useState("");
  const [createCreditNote, setCreateCreditNote] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { voidInvoice } = useTransactionReversal();
  const { formatCurrency } = useCurrency();

  const hasPayments = invoice && invoice.amount_paid > 0;

  const handleVoid = async () => {
    if (!invoice || !reason.trim()) return;

    setIsSubmitting(true);
    try {
      const success = await voidInvoice({
        invoiceId: invoice.id,
        reason: reason.trim(),
        createCreditNote: hasPayments && createCreditNote,
      });

      if (success) {
        setReason("");
        onOpenChange(false);
        onSuccess?.();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!invoice) return null;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          Void Invoice
        </span>
      }
      description={<>Void invoice <strong>{invoice.invoice_number}</strong></>}
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
          }
          trailing={
            <Button
              variant="destructive"
              onClick={handleVoid}
              disabled={isSubmitting || !reason.trim()}
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Void Invoice
            </Button>
          }
        />
      }
    >
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <p className="font-medium">This action cannot be undone.</p>
            <p className="text-sm mt-1">
              Voiding this invoice will create GL reversal entries to maintain audit trail integrity.
            </p>
          </AlertDescription>
        </Alert>

        <div className="rounded-lg border p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Invoice Total:</span>
            <span className="font-medium">
              {formatCurrency(invoice.total, invoice.currency)}
            </span>
          </div>
          {hasPayments && (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount Paid:</span>
                <span className="font-medium text-green-600">
                  {formatCurrency(invoice.amount_paid, invoice.currency)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Balance:</span>
                <span className="font-medium">
                  {formatCurrency(invoice.total - invoice.amount_paid, invoice.currency)}
                </span>
              </div>
            </>
          )}
        </div>

        {hasPayments && (
          <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
            <Checkbox
              id="createCreditNote"
              checked={createCreditNote}
              onCheckedChange={(checked) => setCreateCreditNote(checked === true)}
            />
            <div>
              <Label htmlFor="createCreditNote" className="font-medium">
                Create Credit Note for Refund
              </Label>
              <p className="text-xs text-muted-foreground mt-1">
                A credit note of {formatCurrency(invoice.amount_paid, invoice.currency)} will be created 
                to track the refund owed to the customer.
              </p>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="reason">
            Reason for Voiding <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="reason"
            placeholder="e.g., Invoice created for wrong customer, duplicate entry, etc."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
          />
        </div>
      </div>
    </DetailSheet>
  );
}
