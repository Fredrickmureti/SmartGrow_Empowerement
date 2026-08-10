import { useState, useEffect, useMemo } from "react";
import { Bill, BillPayment, useBills } from "@/hooks/useBills";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useDocumentBranding } from "@/hooks/useDocumentBranding";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { isMpesaSupported } from "@/lib/regionConfig";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
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
import { Loader2, CalendarClock, AlertTriangle, CheckCircle2, Clock, Plus, X } from "lucide-react";
import { format, isPast, parseISO } from "date-fns";
import { normalizeError } from "@/services/resilience";

interface RecordBillPaymentDialogProps {
  bill: Bill | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface AllocationLine {
  bill_id: string;
  amount: number;
}

function PaymentHistoryList({
  payments,
  formatCurrency,
  currency,
}: {
  payments: BillPayment[];
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
            key={`${p.id}-${p.amount}`}
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
              {(p.allocation_count ?? 1) > 1 && (
                <span className="text-muted-foreground text-xs">
                  • split across {p.allocation_count} bills
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

const toCents = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100);

/**
 * Deterministic settlement request key for AP money-out — mirrors
 * `makeCustomerPaymentRequestId` on the AR side. Same payment intent (vendor,
 * allocation set, total, date) → same key, so a double submit or a retry after
 * a network timeout collapses onto one vendor payment server-side.
 * Never `crypto.randomUUID()`.
 */
export function makeVendorPaymentRequestId(input: {
  vendorId: string;
  allocations: Array<{ bill_id: string; amount: number }>;
  totalCents: number;
  paymentDate: string;
}): string {
  const alloc = [...input.allocations]
    .map((a) => `${a.bill_id}:${toCents(a.amount)}`)
    .sort()
    .join("|");
  return `bpm-${input.vendorId}-${input.paymentDate}-${input.totalCents}-${alloc || "unapplied"}`;
}

export function RecordBillPaymentDialog({
  bill,
  open,
  onOpenChange,
  onSuccess,
}: RecordBillPaymentDialogProps) {
  const { bills, recordMultiBillPayment, getBillPayments } = useBills();
  const { currentOrg } = useOrganization();
  const { branding } = useDocumentBranding(
    (bill as any)?.business_id ?? null,
    (bill as any)?.branch_id ?? null,
  );
  const { accounts: bankAccounts } = useBankAccounts();
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();
  const showMpesa = isMpesaSupported(branding?.country ?? null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [payments, setPayments] = useState<BillPayment[]>([]);
  const [loadingPayments, setLoadingPayments] = useState(false);

  // Other open bills for this vendor (excluding the primary bill).
  const otherOpenBills = useMemo(() => {
    if (!bill?.vendor_id) return [];
    return bills.filter(
      (b) =>
        b.id !== bill.id &&
        b.vendor_id === bill.vendor_id &&
        b.currency === bill.currency &&
        b.status !== "paid" &&
        b.status !== "void" &&
        b.status !== "draft" &&
        (b.total - (b.amount_paid || 0)) > 0.005,
    );
  }, [bills, bill?.id, bill?.vendor_id, bill?.currency]);

  const vendorName = bill?.vendor?.name || "Unknown Supplier";

  const [allocations, setAllocations] = useState<AllocationLine[]>([]);
  const [formData, setFormData] = useState({
    payment_date: new Date().toISOString().split("T")[0],
    payment_method: "bank_transfer",
    reference: "",
    notes: "",
    bank_account_id: "",
  });

  useEffect(() => {
    if (open && bill) {
      const balance = bill.total - (bill.amount_paid || 0);
      setAllocations([{ bill_id: bill.id, amount: balance }]);
      setFormData({
        payment_date: new Date().toISOString().split("T")[0],
        payment_method: "bank_transfer",
        reference: "",
        notes: "",
        bank_account_id: bankAccounts.find((a) => a.is_primary)?.id || "",
      });
      setLoadingPayments(true);
      getBillPayments(bill.id)
        .then(setPayments)
        .catch(() => setPayments([]))
        .finally(() => setLoadingPayments(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bill?.id]);

  const billById = useMemo(() => {
    const map: Record<string, Bill> = {};
    if (bill) map[bill.id] = bill;
    for (const b of otherOpenBills) map[b.id] = b;
    return map;
  }, [bill, otherOpenBills]);

  const totalAllocated = useMemo(
    () => allocations.reduce((s, a) => s + (Number.isFinite(a.amount) ? a.amount : 0), 0),
    [allocations],
  );

  const availableForAdd = useMemo(() => {
    const used = new Set(allocations.map((a) => a.bill_id));
    return otherOpenBills.filter((b) => !used.has(b.id));
  }, [allocations, otherOpenBills]);

  const isOverdue = bill ? isPast(parseISO(bill.due_date)) && (bill.total - (bill.amount_paid || 0)) > 0 : false;

  // Idempotency key derived from the payment intent — a double-click or a
  // retry after a timeout replays the same vendor payment instead of paying twice.
  const requestId = useMemo(
    () =>
      makeVendorPaymentRequestId({
        vendorId: bill?.vendor_id ?? "",
        allocations,
        totalCents: toCents(totalAllocated),
        paymentDate: formData.payment_date,
      }),
    [bill?.vendor_id, allocations, totalAllocated, formData.payment_date],
  );


  const setAllocationAmount = (billId: string, amount: number) => {
    setAllocations((prev) =>
      prev.map((a) => (a.bill_id === billId ? { ...a, amount: isNaN(amount) ? 0 : amount } : a)),
    );
  };

  const addAllocation = (billId: string) => {
    const b = billById[billId];
    if (!b) return;
    const open = b.total - (b.amount_paid || 0);
    setAllocations((prev) => [...prev, { bill_id: billId, amount: open }]);
  };

  const removeAllocation = (billId: string) => {
    if (allocations.length === 1) return; // primary bill is mandatory
    setAllocations((prev) => prev.filter((a) => a.bill_id !== billId));
  };

  const validateBeforeSubmit = (): string | null => {
    if (!bill?.vendor_id) return "Bill has no vendor.";
    if (allocations.length === 0) return "Add at least one bill to allocate.";
    for (const a of allocations) {
      const b = billById[a.bill_id];
      if (!b) return "Allocation refers to an unknown bill.";
      if (!(a.amount > 0)) return `Allocation for ${b.bill_number} must be positive.`;
      const open = b.total - (b.amount_paid || 0);
      if (a.amount > open + 0.005)
        return `Allocation for ${b.bill_number} (${a.amount}) exceeds its open balance (${open}).`;
    }
    if (totalAllocated <= 0) return "Total allocated must be positive.";
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bill?.vendor_id) return;
    const validationError = validateBeforeSubmit();
    if (validationError) {
      toast({ title: "Cannot record payment", description: validationError, variant: "destructive" });
      return;
    }

    setIsSubmitting(true);
    try {
      await recordMultiBillPayment({
        vendorId: bill.vendor_id,
        allocations: allocations.map((a) => ({ bill_id: a.bill_id, amount: a.amount })),
        total: totalAllocated,
        payment_date: formData.payment_date,
        payment_method: formData.payment_method,
        reference: formData.reference || null,
        notes: formData.notes || null,
        bank_account_id: formData.bank_account_id || null,
        branch_id: (bill as any).branch_id ?? null,
      });
      toast({
        title: "Payment recorded",
        description:
          allocations.length === 1
            ? `Settled ${formatCurrency(totalAllocated, bill.currency)} against ${bill.bill_number}.`
            : `Settled ${formatCurrency(totalAllocated, bill.currency)} across ${allocations.length} bills.`,
      });
      onOpenChange(false);
      onSuccess();
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record Bill Payment</DialogTitle>
          <DialogDescription>
            Pay {vendorName} — {bill?.bill_number}
            {allocations.length > 1 && ` (+${allocations.length - 1} more)`}
          </DialogDescription>
        </DialogHeader>

        {/* Bill Summary Card */}
        <Card className="border-border">
          <CardContent className="p-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">Supplier</span>
              <p className="font-semibold truncate">{vendorName}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Bill Total</span>
              <p className="font-semibold">{formatCurrency(bill?.total || 0, bill?.currency)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Already Paid</span>
              <p className="font-medium text-green-600">
                {formatCurrency(bill?.amount_paid || 0, bill?.currency)}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Outstanding</span>
              <p className="font-semibold text-primary">
                {formatCurrency((bill?.total || 0) - (bill?.amount_paid || 0), bill?.currency)}
              </p>
            </div>
            <div className="col-span-2 flex items-center gap-2 pt-1 border-t border-border">
              {isOverdue ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  <span className="text-destructive text-xs font-medium">
                    Overdue — was due {bill ? format(parseISO(bill.due_date), "dd MMM yyyy") : ""}
                  </span>
                </>
              ) : (
                <>
                  <CalendarClock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground text-xs">
                    Due {bill ? format(parseISO(bill.due_date), "dd MMM yyyy") : ""}
                  </span>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Payment History */}
        {loadingPayments ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-3.5 w-3.5 animate-spin" /> Loading history…
          </div>
        ) : (
          <PaymentHistoryList
            payments={payments}
            formatCurrency={formatCurrency}
            currency={bill?.currency}
          />
        )}

        {/* Payment Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Allocations */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Bills to settle</Label>
              <span className="text-xs text-muted-foreground">
                {allocations.length} bill{allocations.length !== 1 ? "s" : ""} • Total{" "}
                <span className="font-semibold text-foreground">
                  {formatCurrency(totalAllocated, bill?.currency)}
                </span>
              </span>
            </div>
            <div className="space-y-2 rounded-md border border-border p-2">
              {allocations.map((a) => {
                const b = billById[a.bill_id];
                if (!b) return null;
                const open = b.total - (b.amount_paid || 0);
                const isPrimary = a.bill_id === bill?.id;
                return (
                  <div
                    key={a.bill_id}
                    className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{b.bill_number}</div>
                      <div className="text-xs text-muted-foreground">
                        Open: {formatCurrency(open, b.currency)} • Due{" "}
                        {format(parseISO(b.due_date), "dd MMM yyyy")}
                      </div>
                    </div>
                    <Input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={open}
                      value={a.amount}
                      onChange={(e) => setAllocationAmount(a.bill_id, parseFloat(e.target.value))}
                      className="w-32"
                      required
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={() => setAllocationAmount(a.bill_id, open)}
                      title="Pay this bill in full"
                    >
                      Full
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => removeAllocation(a.bill_id)}
                      disabled={isPrimary}
                      title={isPrimary ? "Primary bill cannot be removed" : "Remove allocation"}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}

              {availableForAdd.length > 0 && (
                <div className="flex items-center gap-2 pt-1">
                  <Select
                    onValueChange={(v) => addAllocation(v)}
                    value=""
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue
                        placeholder={
                          <span className="flex items-center gap-2 text-sm">
                            <Plus className="h-3.5 w-3.5" /> Add another open bill from {vendorName}
                          </span>
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {availableForAdd.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.bill_number} —{" "}
                          {formatCurrency(b.total - (b.amount_paid || 0), b.currency)} open
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="bp-date">Payment Date *</Label>
              <Input
                id="bp-date"
                type="date"
                value={formData.payment_date}
                onChange={(e) =>
                  setFormData({ ...formData, payment_date: e.target.value })
                }
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="bp-method">Method *</Label>
              <Select
                value={formData.payment_method}
                onValueChange={(value) =>
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

          {bankAccounts.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="bp-bank">Bank Account</Label>
              <Select
                value={formData.bank_account_id}
                onValueChange={(value) =>
                  setFormData({ ...formData, bank_account_id: value })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select bank account" />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.filter((a) => a.is_active !== false).map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      {acc.name}
                      {acc.bank_name ? ` (${acc.bank_name})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="bp-reference">Reference / Transaction ID</Label>
            <Input
              id="bp-reference"
              value={formData.reference}
              onChange={(e) =>
                setFormData({ ...formData, reference: e.target.value })
              }
              placeholder="e.g., TXN-12345"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="bp-notes">Notes</Label>
            <Textarea
              id="bp-notes"
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              rows={2}
              placeholder="Optional notes…"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || totalAllocated <= 0}
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record Payment{allocations.length > 1 ? ` (${allocations.length} bills)` : ""}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
