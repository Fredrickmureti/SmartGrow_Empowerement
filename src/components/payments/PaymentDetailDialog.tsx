import { useState, useEffect } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { useNavigate } from "react-router-dom";
import { Payment } from "@/hooks/usePayments";
import { useCurrency } from "@/hooks/useCurrency";
import { usePaymentAllocations } from "@/hooks/usePaymentAllocations";
import { supabase } from "@/integrations/supabase/client";
import { ReallocatePaymentDialog } from "@/components/payments/ReallocatePaymentDialog";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DocumentHistoryTab } from "@/components/common/DocumentHistoryTab";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import { ContactPreviewDrawer } from "@/components/contacts/ContactPreviewDrawer";
import {
  CreditCard,
  Calendar,
  Building2,
  Hash,
  FileText,
  Printer,
  Ban,
  Unlink,
  Clock,
  Banknote,
  BookOpen,
  ExternalLink,
  Wallet,
  ListChecks,
  Shuffle,
} from "lucide-react";
import { format } from "date-fns";

interface PaymentDetailDialogProps {
  payment: (Payment & { status?: string }) | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVoid?: () => void;
  onUnreconcile?: () => void;
  onPrintReceipt?: () => void;
}

const methodLabels: Record<string, string> = {
  cash: "Cash",
  bank_transfer: "Bank Transfer",
  credit_card: "Credit Card",
  check: "Check",
  mpesa: "M-Pesa",
  mobile_money: "Mobile Money",
  other: "Other",
};

export function PaymentDetailDialog({
  payment,
  open,
  onOpenChange,
  onVoid,
  onUnreconcile,
  onPrintReceipt,
}: PaymentDetailDialogProps) {
  const { formatCurrency } = useCurrency();
  const navigate = useNavigate();
  const [contactDrawerOpen, setContactDrawerOpen] = useState(false);
  const [contactDrawerId, setContactDrawerId] = useState<string | null>(null);
  const [reallocateOpen, setReallocateOpen] = useState(false);
  const [paymentJE, setPaymentJE] = useState<{ id: string; entry_number: string; lines: { account_name: string; account_code: string; debit: number; credit: number }[] } | null>(null);
  const { allocations, totalAllocated } = usePaymentAllocations(open ? payment?.id : null);

  useEffect(() => {
    if (!payment?.id || !open) { setPaymentJE(null); return; }
    (async () => {
      try {
        // @ts-ignore
        const { data: jes } = await supabase
          .from("journal_entries")
          .select("id, entry_number")
          .eq("source_type", "payment")
          .eq("source_id", payment.id)
          .limit(1);
        const je = jes?.[0];
        if (!je) { setPaymentJE(null); return; }
        // @ts-ignore
        const { data: lines } = await supabase
          .from("journal_entry_lines")
          .select("debit, credit, accounts:account_id(name, code)")
          .eq("journal_entry_id", je.id)
          .order("debit", { ascending: false });
        setPaymentJE({
          ...je,
          lines: (lines || []).map((l: any) => ({
            account_name: l.accounts?.name || "Unknown",
            account_code: l.accounts?.code || "",
            debit: l.debit || 0,
            credit: l.credit || 0,
          })),
        });
      } catch { setPaymentJE(null); }
    })();
  }, [payment?.id, open]);

  if (!payment) return null;

  const isVoided = payment.status === "voided";
  const isUnreconciled = payment.status === "unreconciled";

  const statusBadge = isVoided
    ? <Badge variant="destructive">Voided</Badge>
    : isUnreconciled
    ? <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300">Unreconciled</Badge>
    : <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">Applied</Badge>;

  const handleOpenContact = () => {
    const cId = payment.contact_id || (payment as any).invoice?.contact_id;
    if (cId) {
      setContactDrawerId(cId);
      setContactDrawerOpen(true);
    }
  };

  const handleOpenInvoice = (invoiceId: string) => {
    onOpenChange(false);
    navigate(`/sales/invoices?id=${invoiceId}`);
  };

  const customerName = payment.contact?.name || "Unknown customer";
  const hasContactId = !!(payment.contact_id || (payment as any).invoice?.contact_id);
  // Allocation-first (ADR 0027): derive applied-invoice summary from
  // `payment_allocations` exclusively. The legacy single-FK column is
  // deprecated and not consulted here.
  const allocationCount = allocations.length;
  const paymentAmount = Number(payment.amount) || 0;
  const outstandingAmount = Number((payment as any).outstanding_amount ?? 0) || 0;
  const appliedAmount = totalAllocated || (paymentAmount - outstandingAmount);
  const unappliedAmount = Math.max(paymentAmount - appliedAmount, 0);

  const appliedSummaryLabel = (() => {
    if (allocationCount === 0 && outstandingAmount > 0) return "Customer Deposit (unapplied)";
    if (allocationCount === 0) return "—";
    if (allocationCount === 1) return allocations[0].invoice?.invoice_number || "1 invoice";
    return `${allocationCount} invoices`;
  })();

  return (
    <>
      <DetailSheet
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={
          <div className="flex items-center gap-2">
            <span>{payment.receipt_number || "Payment"}</span>
            {statusBadge}
          </div>
        }
        description={
          <div className="flex items-center justify-between gap-4">
            <div>
              {hasContactId ? (
                <ClickableEntity onClick={handleOpenContact} className="text-sm">
                  {customerName}
                </ClickableEntity>
              ) : (
                <span className="text-sm text-muted-foreground">{customerName}</span>
              )}
            </div>
            <div className={`text-lg font-bold ${isVoided ? "line-through text-muted-foreground" : ""}`}>
              {formatCurrency(payment.amount)}
            </div>
          </div>
        }
      >
        <ScrollArea className="max-h-[70vh]">
          <div className="space-y-4 sm:space-y-5">

              <Separator />

              {/* Details Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <DetailRow icon={Calendar} label="Payment Date" value={format(new Date(payment.payment_date), "MMMM d, yyyy")} />
                <DetailRow icon={CreditCard} label="Method" value={methodLabels[payment.payment_method] || payment.payment_method} />
                <DetailRow icon={Hash} label="Receipt Number" value={payment.receipt_number || "—"} />
                <DetailRow icon={Hash} label="Reference" value={payment.reference || "—"} />
                <DetailRow icon={Building2} label="Customer" value={
                  hasContactId ? (
                    <ClickableEntity onClick={handleOpenContact}>{customerName}</ClickableEntity>
                  ) : customerName
                } />
                <DetailRow icon={FileText} label="Applied to" value={
                  allocationCount === 1 && allocations[0].invoice ? (
                    <ClickableEntity onClick={() => handleOpenInvoice(allocations[0].invoice!.id)}>
                      {allocations[0].invoice.invoice_number}
                    </ClickableEntity>
                  ) : (
                    <span className={allocationCount === 0 ? "text-muted-foreground" : "font-medium"}>
                      {appliedSummaryLabel}
                    </span>
                  )
                } />
              </div>

              {/* Quick Actions */}
              {(!isVoided) && (onPrintReceipt || onVoid || onUnreconcile) && (
                <>
                  <Separator />
                  <div className="flex gap-2 flex-wrap">
                    {onPrintReceipt && (
                      <Button size="sm" onClick={onPrintReceipt}>
                        <Printer className="h-4 w-4 mr-2" />
                        Print Receipt
                      </Button>
                    )}
                    {onVoid && (
                      <Button variant="outline" size="sm" onClick={onVoid}>
                        <Ban className="h-4 w-4 mr-2" />
                        Void Payment
                      </Button>
                    )}
                    {onUnreconcile && !isUnreconciled && (
                      <Button variant="outline" size="sm" onClick={onUnreconcile}>
                        <Unlink className="h-4 w-4 mr-2" />
                        Unreconcile
                      </Button>
                    )}
                    {!isVoided && payment.contact_id && (
                      <Button variant="outline" size="sm" onClick={() => setReallocateOpen(true)}>
                        <Shuffle className="h-4 w-4 mr-2" />
                        Reallocate
                      </Button>
                    )}
                  </div>
                </>
              )}

              {/* Allocation breakdown — always rendered when there are allocations.
                  Single-invoice, multi-invoice, and overpayment paths all flow
                  through the same allocation-first model (ADR 0012 + Phase 2). */}
              {allocationCount > 0 && (
                <>
                  <Separator />
                  <div>
                    <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                      <ListChecks className="h-4 w-4" />
                      Applied Invoices ({allocationCount})
                    </h4>
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-muted/50">
                            <th className="text-left px-3 py-2 font-medium">Invoice</th>
                            <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Invoice Total</th>
                            <th className="text-right px-3 py-2 font-medium">Applied</th>
                            <th className="text-right px-3 py-2 font-medium hidden sm:table-cell">Balance After</th>
                            <th className="text-left px-3 py-2 font-medium hidden md:table-cell">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {allocations.map((alloc) => {
                            const inv = alloc.invoice;
                            const balanceAfter = inv ? Math.max(inv.total - inv.amount_paid, 0) : 0;
                            return (
                              <tr key={alloc.id} className="border-t">
                                <td className="px-3 py-2">
                                  {inv ? (
                                    <ClickableEntity onClick={() => handleOpenInvoice(inv.id)}>
                                      {inv.invoice_number}
                                    </ClickableEntity>
                                  ) : (
                                    <span className="text-muted-foreground italic">Deleted invoice</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell">
                                  {inv ? formatCurrency(inv.total) : "—"}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums font-medium">
                                  {formatCurrency(alloc.amount)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell">
                                  {inv ? formatCurrency(balanceAfter) : "—"}
                                </td>
                                <td className="px-3 py-2 hidden md:table-cell">
                                  {inv && (
                                    <Badge variant="outline" className="capitalize text-xs">
                                      {inv.status}
                                    </Badge>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                          <tr className="border-t bg-muted/30 font-medium">
                            <td className="px-3 py-2">Total applied</td>
                            <td className="px-3 py-2 hidden sm:table-cell" />
                            <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(appliedAmount)}</td>
                            <td className="px-3 py-2 hidden sm:table-cell" />
                            <td className="px-3 py-2 hidden md:table-cell" />
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              {/* Payment Summary — adapts to scenario:
                  fully applied / partial / overpayment / pure customer deposit. */}
              <Separator />
              <div>
                <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                  <Banknote className="h-4 w-4" />
                  Payment Summary
                </h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Payment received</span>
                    <span className="tabular-nums">{formatCurrency(paymentAmount)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Applied to {allocationCount} invoice{allocationCount === 1 ? "" : "s"}
                    </span>
                    <span className="tabular-nums">{formatCurrency(appliedAmount)}</span>
                  </div>
                  {unappliedAmount > 0.005 && (
                    <div className="flex justify-between text-amber-700 dark:text-amber-400">
                      <span className="flex items-center gap-1">
                        <Wallet className="h-3.5 w-3.5" />
                        Unapplied (Customer Deposit)
                      </span>
                      <span className="tabular-nums font-medium">{formatCurrency(unappliedAmount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between border-t pt-2 font-medium text-base">
                    <span>Total</span>
                    <span className="tabular-nums">{formatCurrency(paymentAmount)}</span>
                  </div>
                  {unappliedAmount > 0.005 && (
                    <p className="text-xs text-muted-foreground pt-1">
                      This amount sits on the Customer Deposits liability account and can be applied to a future invoice from the customer record.
                    </p>
                  )}
                </div>
              </div>

              {/* Notes */}
              {payment.notes && (
                <>
                  <Separator />
                  <div>
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      Notes
                    </h4>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">{payment.notes}</p>
                  </div>
                </>
              )}

              {/* Journal Entry */}
              {paymentJE && (
                <>
                  <Separator />
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-medium flex items-center gap-2">
                        <BookOpen className="h-4 w-4" />
                        Journal Entry — {paymentJE.entry_number}
                      </h4>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => {
                          onOpenChange(false);
                          navigate(`/finance/journal-entries?selected=${paymentJE.id}`);
                        }}
                      >
                        View Full Entry <ExternalLink className="h-3 w-3 ml-1" />
                      </Button>
                    </div>
                    {/* Mobile: card layout */}
                    <div className="sm:hidden space-y-2">
                      {paymentJE.lines.map((line, i) => (
                        <div key={i} className="rounded-lg border p-3 space-y-1">
                          <div className="text-sm font-medium truncate">
                            <span className="text-muted-foreground mr-1">{line.account_code}</span>
                            {line.account_name}
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Debit</span>
                            <span className="tabular-nums">{line.debit > 0 ? formatCurrency(line.debit) : "—"}</span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Credit</span>
                            <span className="tabular-nums">{line.credit > 0 ? formatCurrency(line.credit) : "—"}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* Desktop: table layout */}
                    <div className="hidden sm:block rounded-lg border overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-muted/50">
                            <th className="text-left px-3 py-2 font-medium">Account</th>
                            <th className="text-right px-3 py-2 font-medium">Debit</th>
                            <th className="text-right px-3 py-2 font-medium">Credit</th>
                          </tr>
                        </thead>
                        <tbody>
                          {paymentJE.lines.map((line, i) => (
                            <tr key={i} className="border-t">
                              <td className="px-3 py-2">
                                <span className="text-muted-foreground mr-1">{line.account_code}</span>
                                {line.account_name}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {line.debit > 0 ? formatCurrency(line.debit) : "—"}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {line.credit > 0 ? formatCurrency(line.credit) : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}

              {/* Activity History */}
              <Separator />
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Activity History
                </h4>
                <DocumentHistoryTab entityType="payments" entityId={payment.id} />
              </div>
          </div>
        </ScrollArea>
      </DetailSheet>


      <ContactPreviewDrawer
        open={contactDrawerOpen}
        onOpenChange={setContactDrawerOpen}
        contactId={contactDrawerId}
      />

      <ReallocatePaymentDialog
        open={reallocateOpen}
        onOpenChange={setReallocateOpen}
        payment={
          payment
            ? {
                id: payment.id,
                amount: Number(payment.amount) || 0,
                contact_id: payment.contact_id ?? null,
                business_id: (payment as any).business_id ?? null,
                currency: (payment as any).currency ?? null,
              }
            : null
        }
      />
    </>
  );
}
