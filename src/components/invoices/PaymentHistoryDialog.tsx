import { useState, useEffect } from "react";
import { Invoice } from "@/hooks/useInvoices";
import { usePayments, Payment } from "@/hooks/usePayments";
import { useCurrency } from "@/hooks/useCurrency";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, MoreHorizontal, Ban, Unlink, ArrowRightLeft } from "lucide-react";
import { format } from "date-fns";
import { VoidPaymentDialog } from "@/components/payments/VoidPaymentDialog";
import { ReversePaymentWizard } from "@/components/payments/ReversePaymentWizard";
import { ReapplyPaymentDialog } from "@/components/payments/ReapplyPaymentDialog";

interface PaymentHistoryDialogProps {
  invoice: Invoice | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const paymentMethodLabels: Record<Payment["payment_method"], string> = {
  bank_transfer: "Bank Transfer",
  cash: "Cash",
  credit_card: "Credit Card",
  check: "Check",
  mpesa: "M-Pesa",
  mobile_money: "Mobile Money",
  other: "Other",
};

// Extended payment type with status
interface PaymentWithStatus extends Payment {
  status?: "applied" | "voided" | "unreconciled";
}

export function PaymentHistoryDialog({
  invoice,
  open,
  onOpenChange,
}: PaymentHistoryDialogProps) {
  const { getPaymentsForInvoice } = usePayments();
  const { formatCurrency: formatCurrencyHook } = useCurrency();
  const [payments, setPayments] = useState<PaymentWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  
  // Dialog states for payment actions
  const [selectedPayment, setSelectedPayment] = useState<PaymentWithStatus | null>(null);
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [showUnreconcileDialog, setShowUnreconcileDialog] = useState(false);
  const [showReapplyDialog, setShowReapplyDialog] = useState(false);

  useEffect(() => {
    if (open && invoice) {
      loadPayments();
    }
  }, [open, invoice?.id]);

  const loadPayments = async () => {
    if (!invoice) return;
    setIsLoading(true);
    try {
      const data = await getPaymentsForInvoice(invoice.id);
      setPayments(data as PaymentWithStatus[]);
    } catch (error) {
      console.error("Error loading payments:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // Use the hook's formatCurrency with invoice currency
  const formatCurrency = (amount: number) => {
    return formatCurrencyHook(amount, invoice?.currency || "USD"); // architecture-allow: display-only fallback
  };

  // Filter out voided payments for totals calculation
  const activePayments = payments.filter(p => p.status !== "voided");
  const totalPaid = activePayments.reduce((sum, p) => sum + p.amount, 0);
  const balance = invoice ? invoice.total - totalPaid : 0;

  const getPaymentStatusBadge = (payment: PaymentWithStatus) => {
    if (payment.status === "voided") {
      return <Badge variant="destructive">Voided</Badge>;
    }
    if (payment.status === "unreconciled") {
      return <Badge variant="secondary">Unreconciled</Badge>;
    }
    return null;
  };

  const handleActionSuccess = () => {
    loadPayments(); // Refresh the list
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Payment History</DialogTitle>
            <DialogDescription>
              {invoice?.invoice_number} • {invoice?.contact?.name || "No customer"}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : payments.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No payments recorded for this invoice.
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Receipt #</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((payment) => (
                    <TableRow 
                      key={payment.id}
                      className={payment.status === "voided" ? "opacity-50" : ""}
                    >
                      <TableCell>
                        {format(new Date(payment.payment_date), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {payment.receipt_number}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {paymentMethodLabels[payment.payment_method]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {payment.reference || "—"}
                      </TableCell>
                      <TableCell>
                        {getPaymentStatusBadge(payment)}
                      </TableCell>
                      <TableCell className={`text-right font-medium ${
                        payment.status === "voided" ? "line-through" : ""
                      }`}>
                        {formatCurrency(payment.amount)}
                      </TableCell>
                      <TableCell>
                        {payment.status !== "voided" && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => {
                                  setSelectedPayment(payment);
                                  setShowUnreconcileDialog(true);
                                }}
                              >
                                <Unlink className="mr-2 h-4 w-4" />
                                Un-reconcile
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => {
                                  setSelectedPayment(payment);
                                  setShowVoidDialog(true);
                                }}
                                className="text-destructive"
                              >
                                <Ban className="mr-2 h-4 w-4" />
                                Void Payment
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="border-t pt-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Invoice Total</span>
                  <span>{formatCurrency(invoice?.total || 0)}</span>
                </div>
                <div className="flex justify-between text-sm text-green-600">
                  <span>Total Paid</span>
                  <span>{formatCurrency(totalPaid)}</span>
                </div>
                <div className="flex justify-between font-bold">
                  <span>Balance Due</span>
                  <span className={balance > 0 ? "text-destructive" : "text-green-600"}>
                    {formatCurrency(balance)}
                  </span>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Void Payment Dialog */}
      <VoidPaymentDialog
        payment={selectedPayment}
        open={showVoidDialog}
        onOpenChange={setShowVoidDialog}
        onSuccess={handleActionSuccess}
      />

      {/* Un-reconcile → ADR 0012 wrong_invoice_applied (unapply, parks cash on Customer Deposits) */}
      <ReversePaymentWizard
        payment={selectedPayment ? {
          id: selectedPayment.id,
          receipt_number: selectedPayment.receipt_number,
          amount: selectedPayment.amount,
          outstanding_amount: (selectedPayment as any).outstanding_amount ?? null,
          applied_amount: (selectedPayment as any).applied_amount ?? null,
          payment_date: (selectedPayment as any).payment_date ?? new Date().toISOString().slice(0, 10),
          invoice: invoice ? { id: invoice.id, invoice_number: invoice.invoice_number } : null,
        } : null}
        open={showUnreconcileDialog}
        onOpenChange={setShowUnreconcileDialog}
        onSuccess={handleActionSuccess}
        initialReasonCode="wrong_invoice_applied"
      />

      {/* Re-apply Payment Dialog */}
      <ReapplyPaymentDialog
        payment={selectedPayment}
        open={showReapplyDialog}
        onOpenChange={setShowReapplyDialog}
        onSuccess={handleActionSuccess}
      />
    </>
  );
}
