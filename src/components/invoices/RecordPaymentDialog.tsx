import { useState, useEffect } from "react";
import { Invoice } from "@/hooks/useInvoices";
import { usePayments, Payment } from "@/hooks/usePayments";
import { useOrganization } from "@/hooks/useOrganization";
import { useDocumentBranding } from "@/hooks/useDocumentBranding";
import { useCurrency } from "@/hooks/useCurrency";
import { useCustomerCredits } from "@/hooks/useCustomerCredits";
import { useCreditNotes } from "@/hooks/useCreditNotes";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useAccounts } from "@/hooks/useAccounts";
import { isMpesaSupported } from "@/lib/regionConfig";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, CalendarClock, AlertTriangle, CheckCircle2, Clock, ArrowRight, Gift, Zap, Landmark } from "lucide-react";
import { format, isPast, parseISO } from "date-fns";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { normalizeError } from "@/services/resilience";

interface RecordPaymentDialogProps {
  invoice: Invoice | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

function PaymentHistoryList({
  payments,
  formatCurrency,
  currency,
}: {
  payments: Payment[];
  formatCurrency: (amount: number, currency?: string) => string;
  currency?: string;
}) {
  if (payments.length === 0) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-muted-foreground">Payment History</h4>
      <div className="space-y-1.5 max-h-32 overflow-y-auto">
        {payments.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between text-sm rounded-md border border-border bg-muted/30 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              <span>{format(parseISO(p.payment_date), "dd MMM yyyy")}</span>
              {p.payment_method && (
                <span className="text-muted-foreground capitalize">
                  • {p.payment_method.replace(/_/g, " ")}
                </span>
              )}
            </div>
            <span className="font-medium">{formatCurrency(p.amount, currency)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RecordPaymentDialog({
  invoice,
  open,
  onOpenChange,
  onSuccess,
}: RecordPaymentDialogProps) {
  const { recordPayment, getPaymentsForInvoice } = usePayments();
  const { applyCreditToInvoice } = useCreditNotes();
  const { currentOrg } = useOrganization();
  const { branding } = useDocumentBranding(
    (invoice as any)?.business_id ?? null,
    (invoice as any)?.branch_id ?? null,
  );
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();
  const { accounts: allAccounts } = useAccounts();
  const { accounts: defaultAccounts } = useDefaultAccounts();
  const showMpesa = isMpesaSupported(branding?.country ?? null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isApplyingCredit, setIsApplyingCredit] = useState(false);
  const [showReceiptPreview, setShowReceiptPreview] = useState(false);
  const [lastPaymentId, setLastPaymentId] = useState<string | null>(null);
  const [lastReceiptNumber, setLastReceiptNumber] = useState<string>("");
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loadingPayments, setLoadingPayments] = useState(false);
  const [depositAccountId, setDepositAccountId] = useState("");

  const contactId = (invoice as any)?.contact_id || (invoice as any)?.contact?.id || null;
  const { credits, totalAvailableCredit, refetch: refetchCredits } = useCustomerCredits(open ? contactId : null);

  const balance = invoice ? invoice.total - invoice.amount_paid : 0;
  const isOverdue = invoice ? isPast(parseISO(invoice.due_date)) && balance > 0 : false;
  const customerName = (invoice as any)?.contact?.name || "Customer";

  // Filter to asset accounts only for deposit
  const assetAccounts = allAccounts.filter(a => a.account_type === "asset" && a.is_active);

  const [formData, setFormData] = useState({
    amount: 0,
    payment_date: format(new Date(), "yyyy-MM-dd"),
    payment_method: "bank_transfer" as Payment["payment_method"],
    reference: "",
    notes: "",
  });

  // Auto-fill deposit account when payment method changes
  const getDepositAccountForMethod = (method: string): string => {
    switch (method) {
      case "cash":
        return defaultAccounts.cash_account_id || defaultAccounts.bank_account_id || "";
      case "bank_transfer":
      case "check":
        return defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      case "credit_card":
        return defaultAccounts.credit_card_clearing_id || defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      case "mpesa":
        return defaultAccounts.mpesa_account_id || defaultAccounts.mobile_money_account_id || defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      case "mobile_money":
        return defaultAccounts.mobile_money_account_id || defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      default:
        return defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
    }
  };

  // Derived: overpayment detection
  const overpaymentAmount = Math.max(0, formData.amount - balance);
  const appliedToInvoice = Math.min(formData.amount, balance);
  const remainingAfterPayment = Math.max(0, balance - formData.amount);
  const resultingStatus = remainingAfterPayment <= 0 ? "Paid" : "Partially Paid";

  // Reset form when dialog opens with new invoice
  useEffect(() => {
    if (open && invoice) {
      const defaultMethod = "bank_transfer";
      setFormData({
        amount: invoice.total - invoice.amount_paid,
        payment_date: format(new Date(), "yyyy-MM-dd"),
        payment_method: defaultMethod,
        reference: "",
        notes: "",
      });
      setDepositAccountId(getDepositAccountForMethod(defaultMethod));
      setLoadingPayments(true);
      getPaymentsForInvoice(invoice.id)
        .then(setPayments)
        .catch(() => setPayments([]))
        .finally(() => setLoadingPayments(false));
    }
  }, [open, invoice?.id]);

  // Update deposit account when payment method changes
  useEffect(() => {
    setDepositAccountId(getDepositAccountForMethod(formData.payment_method));
  }, [formData.payment_method, defaultAccounts]);

  const handleApplyCredit = async (creditNoteId: string, amount: number) => {
    if (!invoice) return;
    setIsApplyingCredit(true);
    try {
      await applyCreditToInvoice(creditNoteId, invoice.id, amount, "Applied from payment dialog");
      toast({ title: "Credit applied successfully" });
      onSuccess();
      refetchCredits();
      const updatedPayments = await getPaymentsForInvoice(invoice.id);
      setPayments(updatedPayments);
    } catch (error: any) {
      toast({
        title: "Error applying credit",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsApplyingCredit(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invoice) return;

    if (!depositAccountId) {
      toast({
        title: "Deposit account required",
        description: "Please select the GL account that will receive these funds.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const newPayment = await recordPayment({
        invoice_id: invoice.id,
        amount: formData.amount,
        payment_date: formData.payment_date,
        payment_method: formData.payment_method,
        reference: formData.reference || undefined,
        notes: formData.notes || undefined,
        deposit_account_id: depositAccountId,
      });

      const overpayMsg = newPayment.overpayment_amount > 0
        ? ` — ${formatCurrency(newPayment.overpayment_amount, invoice.currency)} recorded as customer credit`
        : "";

      toast({ title: `Payment recorded successfully${overpayMsg}` });
      onOpenChange(false);
      onSuccess();

      // Show server-side PDF receipt preview
      setLastPaymentId(newPayment.id);
      setLastReceiptNumber(newPayment.receipt_number || `RCP-${Date.now()}`);
      setShowReceiptPreview(true);
    } catch (error: any) {
      toast({
        title: "Error recording payment",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Find the selected deposit account name for the preview
  const selectedDepositAccount = assetAccounts.find(a => a.id === depositAccountId);
  const depositAccountLabel = selectedDepositAccount
    ? `${selectedDepositAccount.code} - ${selectedDepositAccount.name}`
    : "Not selected";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Receive Payment</DialogTitle>
            <DialogDescription>
              From {customerName} — {invoice?.invoice_number}
            </DialogDescription>
          </DialogHeader>

          {/* Invoice Summary Card */}
          <Card className="border-border">
            <CardContent className="p-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">Customer</span>
                <p className="font-semibold truncate">{customerName}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Invoice Total</span>
                <p className="font-semibold">
                  {formatCurrency(invoice?.total || 0, invoice?.currency)}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Already Paid</span>
                <p className="font-medium text-green-600">
                  {formatCurrency(invoice?.amount_paid || 0, invoice?.currency)}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Outstanding</span>
                <p className="font-semibold text-primary">
                  {formatCurrency(balance, invoice?.currency)}
                </p>
              </div>
              <div className="col-span-2 flex items-center gap-2 pt-1 border-t border-border">
                {isOverdue ? (
                  <>
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                    <span className="text-destructive text-xs font-medium">
                      Overdue — was due {invoice ? format(parseISO(invoice.due_date), "dd MMM yyyy") : ""}
                    </span>
                  </>
                ) : (
                  <>
                    <CalendarClock className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground text-xs">
                      Due {invoice ? format(parseISO(invoice.due_date), "dd MMM yyyy") : ""}
                    </span>
                  </>
                )}
                <Badge variant="outline" className="ml-auto text-xs">
                  {invoice?.status}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* Available Customer Credits */}
          {totalAvailableCredit > 0 && (
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Gift className="h-4 w-4 text-primary" />
                  <span>Customer has {formatCurrency(totalAvailableCredit, invoice?.currency)} available credit</span>
                </div>
                <div className="space-y-1.5">
                  {credits.map((credit) => (
                    <div key={credit.id} className="flex items-center justify-between text-xs rounded border border-border bg-background px-3 py-2">
                      <div>
                        <span className="font-mono">{credit.credit_note_number}</span>
                        <span className="text-muted-foreground ml-2">
                          {formatCurrency(credit.available, invoice?.currency)} available
                        </span>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={isApplyingCredit}
                        onClick={() => handleApplyCredit(credit.id, Math.min(credit.available, balance))}
                      >
                        {isApplyingCredit ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <Zap className="h-3 w-3 mr-1" />
                            Apply {formatCurrency(Math.min(credit.available, balance), invoice?.currency)}
                          </>
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Payment History */}
          {loadingPayments ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-3.5 w-3.5 animate-spin" /> Loading history…
            </div>
          ) : (
            <PaymentHistoryList
              payments={payments}
              formatCurrency={formatCurrency}
              currency={invoice?.currency}
            />
          )}

          {/* Payment Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="rp-amount">Amount *</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto py-0.5 px-2 text-xs"
                  onClick={() => setFormData({ ...formData, amount: balance })}
                >
                  Pay full balance
                </Button>
              </div>
              <Input
                id="rp-amount"
                type="number"
                step="0.01"
                min="0.01"
                value={formData.amount}
                onChange={(e) =>
                  setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })
                }
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="rp-date">Payment Date *</Label>
                <Input
                  id="rp-date"
                  type="date"
                  value={formData.payment_date}
                  onChange={(e) =>
                    setFormData({ ...formData, payment_date: e.target.value })
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="rp-method">Method *</Label>
                <Select
                  value={formData.payment_method}
                  onValueChange={(value: Payment["payment_method"]) =>
                    setFormData({ ...formData, payment_method: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    {showMpesa && <SelectItem value="mpesa">M-Pesa</SelectItem>}
                    <SelectItem value="mobile_money">Mobile Money</SelectItem>
                    <SelectItem value="credit_card">Credit Card</SelectItem>
                    <SelectItem value="check">Check</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Deposit Account field */}
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Landmark className="h-3.5 w-3.5" />
                Deposit To *
              </Label>
              <AccountCombobox
                accounts={assetAccounts}
                value={depositAccountId}
                onValueChange={setDepositAccountId}
                placeholder="Select deposit account..."
              />
              <p className="text-xs text-muted-foreground">
                The GL account that will be debited for this payment
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rp-reference">Reference / Transaction ID</Label>
              <Input
                id="rp-reference"
                value={formData.reference}
                onChange={(e) =>
                  setFormData({ ...formData, reference: e.target.value })
                }
                placeholder="e.g., TXN-12345"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="rp-notes">Notes</Label>
              <Textarea
                id="rp-notes"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                rows={2}
                placeholder="Optional notes…"
              />
            </div>

            {/* Post-payment preview */}
            {formData.amount > 0 && (
              <Card className={`border-dashed ${overpaymentAmount > 0 ? "border-amber-400 bg-amber-50/50 dark:bg-amber-950/20" : "border-border bg-muted/30"}`}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      <span className="text-muted-foreground">After payment:</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-medium">
                        {formatCurrency(remainingAfterPayment, invoice?.currency)} remaining
                      </span>
                      <Badge variant={remainingAfterPayment <= 0 ? "default" : "secondary"} className="text-xs">
                        {resultingStatus}
                      </Badge>
                    </div>
                  </div>

                  {/* Accounting preview */}
                  <div className="border-t border-border pt-2 space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Journal Entry Preview</p>
                    <div className="grid grid-cols-[1fr_auto] gap-1 text-xs text-muted-foreground pl-2">
                      <span>Dr {depositAccountLabel}</span>
                      <span className="text-right font-mono">{formatCurrency(formData.amount, invoice?.currency)}</span>
                      <span>Cr Accounts Receivable</span>
                      <span className="text-right font-mono">{formatCurrency(appliedToInvoice, invoice?.currency)}</span>
                      {overpaymentAmount > 0 && (
                        <>
                          <span>Cr Customer Deposits</span>
                          <span className="text-right font-mono">{formatCurrency(overpaymentAmount, invoice?.currency)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Overpayment notice */}
                  {overpaymentAmount > 0 && (
                    <div className="flex items-start gap-2 text-sm border-t border-amber-300/50 pt-2">
                      <Gift className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-medium text-amber-700 dark:text-amber-400">
                          Overpayment of {formatCurrency(overpaymentAmount, invoice?.currency)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Will be recorded as customer credit (credit note). Can be applied to future invoices.
                        </p>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting || formData.amount <= 0 || !depositAccountId}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Record Payment
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {lastPaymentId && (
        <PrintPreviewDialog
          open={showReceiptPreview}
          onOpenChange={setShowReceiptPreview}
          title={`Receipt ${lastReceiptNumber}`}
          documentType="receipt"
          documentId={lastPaymentId}
          filename={`Receipt-${lastReceiptNumber}`}
        />
      )}
    </>
  );
}
