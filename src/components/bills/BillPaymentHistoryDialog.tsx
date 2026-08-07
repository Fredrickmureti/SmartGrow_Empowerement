import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Bill, useBills, BillPayment } from "@/hooks/useBills";
import { useTransactionReversal } from "@/hooks/useTransactionReversal";
import { useCurrency } from "@/hooks/useCurrency";
import { supabase } from "@/integrations/supabase/client";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Undo2 } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface BillPaymentHistoryDialogProps {
  bill: Bill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const paymentMethodLabels: Record<string, string> = {
  bank_transfer: "Bank Transfer",
  cash: "Cash",
  credit_card: "Credit Card",
  check: "Check",
  mpesa: "M-Pesa",
  mobile_money: "Mobile Money",
  other: "Other",
};

export function BillPaymentHistoryDialog({
  bill,
  open,
  onOpenChange,
}: BillPaymentHistoryDialogProps) {
  const { getBillPayments } = useBills();
  const { voidBillPayment } = useTransactionReversal();
  const { formatCurrency: formatCurrencyHook } = useCurrency();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [payments, setPayments] = useState<BillPayment[]>([]);
  const [paymentJEs, setPaymentJEs] = useState<Record<string, { id: string; entry_number: string }>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [confirmReversePayment, setConfirmReversePayment] = useState<BillPayment | null>(null);

  useEffect(() => {
    if (open && bill) {
      setIsLoading(true);
      getBillPayments(bill.id)
        .then(async (pmts) => {
          setPayments(pmts);
          // Fetch JE references for each payment
          const jeIds = pmts.map((p: any) => p.journal_entry_id).filter(Boolean);
          if (jeIds.length > 0) {
            const { data } = await supabase
              .from("journal_entries")
              .select("id, entry_number")
              .in("id", jeIds);
            if (data) {
              const map: Record<string, { id: string; entry_number: string }> = {};
              data.forEach((je: any) => { map[je.id] = je; });
              setPaymentJEs(map);
            }
          }
        })
        .catch(() => setPayments([]))
        .finally(() => setIsLoading(false));
    }
  }, [open, bill?.id]);

  const formatCurrency = (amount: number) => {
    return formatCurrencyHook(amount, bill?.currency || "USD"); // architecture-allow: display-only fallback
  };

  const handleReversePayment = async (payment: BillPayment) => {
    if (!bill) return;
    setReversingId(payment.id);
    try {
      const ok = await voidBillPayment({
        billPaymentId: payment.id,
        reason: "Reversed from Bill Payment History",
      });
      if (ok) {
        // Refresh payments list
        const updated = await getBillPayments(bill.id);
        setPayments(updated);
      }
    } catch (error: any) {
      toast({ title: "Reversal failed", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setReversingId(null);
      setConfirmReversePayment(null);
    }
  };

  // Intent is resolved per payment, on demand — never cached across payments,
  // since reconciliation state moves underneath the dialog.
  useEffect(() => {
    if (!confirmReversePayment) {
      setPaymentIntent(null);
      return;
    }
    let cancelled = false;
    setIsResolvingPaymentIntent(true);
    resolveReversalIntent("bill_payment", confirmReversePayment.id)
      .then((result) => {
        if (!cancelled) setPaymentIntent(result);
      })
      .finally(() => {
        if (!cancelled) setIsResolvingPaymentIntent(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmReversePayment?.id]);

  const reverseOption = paymentIntent?.operations.find(
    (op) => op.operation === "reverse_payment" || op.operation === "void"
  );
  const reversalBlockedReason =
    paymentIntent && reverseOption && !reverseOption.allowed
      ? reverseOption.blocked_reason ??
        "This payment's accounting state does not allow a reversal."
      : null;

  const {
    consequences: paymentConsequences,
    isLoading: isPaymentPreviewLoading,
    isError: isPaymentPreviewError,
  } = useReversalConsequences(
    "bill_payment",
    confirmReversePayment?.id,
    Boolean(confirmReversePayment) && !reversalBlockedReason
  );

  const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
  const balance = bill ? bill.total - totalPaid : 0;


  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Bill Payment History</DialogTitle>
            <DialogDescription>
              {bill?.bill_number} • {bill?.vendor?.name || "No vendor"}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : payments.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No payments recorded for this bill.
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Journal Entry</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((payment) => (
                    <TableRow key={payment.id}>
                      <TableCell>
                        {format(new Date(payment.payment_date), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {paymentMethodLabels[payment.payment_method] || payment.payment_method}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {payment.reference || "—"}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const jeId = (payment as any).journal_entry_id;
                          const je = jeId ? paymentJEs[jeId] : null;
                          if (!je) return <span className="text-muted-foreground">—</span>;
                          return (
                            <button
                              type="button"
                              className="text-sm text-primary hover:underline flex items-center gap-1"
                              onClick={() => {
                                onOpenChange(false);
                                navigate(`/finance/journal-entries?selected=${je.id}`);
                              }}
                            >
                              {je.entry_number}
                            </button>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(payment.amount)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          disabled={reversingId === payment.id}
                          onClick={() => setConfirmReversePayment(payment)}
                          title="Reverse payment"
                        >
                          {reversingId === payment.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Undo2 className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="border-t pt-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Bill Total</span>
                  <span>{formatCurrency(bill?.total || 0)}</span>
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

      {/*
        Phase 3 — a supplier payment reversal is authorised the same way a
        customer one is: the server's intent policy says whether it is legal
        (bank-reconciled payments and closed periods are refused) and the
        consequence preview shows the GL and cash impact first. The confirm
        button stays disabled until both have landed. `void_bill_payment_atomic`
        remains the only writer.
      */}
      <AlertDialog open={!!confirmReversePayment} onOpenChange={(open) => { if (!open) setConfirmReversePayment(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reverse Payment</AlertDialogTitle>
            <AlertDialogDescription>
              This will reverse the payment of {confirmReversePayment ? formatCurrency(confirmReversePayment.amount) : ""} and 
              create a reversing journal entry. The bill balance will be restored. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {reversalBlockedReason && (
            <Alert>
              <Lock className="h-4 w-4" />
              <AlertDescription>{reversalBlockedReason}</AlertDescription>
            </Alert>
          )}

          <ReversalConsequencePreview
            consequences={paymentConsequences}
            isLoading={isPaymentPreviewLoading}
            isError={isPaymentPreviewError}
            currency={bill?.currency}
          />

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={
                Boolean(reversalBlockedReason) ||
                isResolvingPaymentIntent ||
                isPaymentPreviewLoading ||
                isPaymentPreviewError ||
                Boolean(reversingId)
              }
              onClick={() => confirmReversePayment && handleReversePayment(confirmReversePayment)}
            >
              Reverse Payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  );
}
