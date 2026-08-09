/**
 * RecordCustomerPaymentDialog — the single customer money-in surface.
 *
 * Replaces the two competing dialogs that used to live at
 * `src/components/invoices/RecordPaymentDialog.tsx` (single-invoice, with
 * payment history / credit application / overpayment preview / receipt
 * preview) and `src/components/sales/RecordPaymentDialog.tsx`
 * (customer-first, multi-invoice allocation off the GL-gated AR projection).
 *
 * Contract:
 *  - Customer-first. An optional focused invoice pre-selects the customer and
 *    that invoice's allocation, and unlocks the single-invoice affordances.
 *  - Residual always comes from `fetchOpenCustomerInvoices`
 *    (`finance_ar_open_items`) — never from an invoice status list.
 *  - Money always enters through `record_multi_invoice_payment` via
 *    `usePayments().recordMultiInvoicePayment`, with a deterministic request
 *    key so a double submit cannot mint a second payment.
 *  - Any amount above the allocated total is sent as excess and lands as
 *    customer credit server-side; the client never posts that itself.
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import { usePayments } from "@/hooks/usePayments";
import type { Payment } from "@/hooks/usePayments";
import type { Invoice } from "@/hooks/useInvoices";
import { useContacts } from "@/hooks/useContacts";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useAccounts } from "@/hooks/useAccounts";
import { useCustomerCredits } from "@/hooks/useCustomerCredits";
import { useCreditNotes } from "@/hooks/useCreditNotes";
import { isMpesaSupported } from "@/lib/regionConfig";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Loader2,
  ArrowRight,
  User,
  FileText,
  CheckCircle2,
  Landmark,
  Gift,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { normalizeError } from "@/services/resilience";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { FieldGroup } from "@/design-system/primitives/FieldGrid";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import {
  fetchOpenCustomerInvoices,
  type OpenCustomerInvoice,
} from "@/services/finance/invoicePayability";

type OpenInvoice = OpenCustomerInvoice;

export interface RecordCustomerPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Focused invoice (Invoices / Accounts Receivable row action). */
  invoice?: Invoice | null;
  /** Focused invoice by id, when the caller has no invoice object. */
  preSelectedInvoiceId?: string;
  /** Pre-selected customer (Collections). */
  preSelectedContactId?: string;
  /** Fired after a successful payment — refresh the caller's read models. */
  onSuccess?: () => void;
  /** Richer success callback used by Customer Payments to offer the receipt. */
  onPaymentRecorded?: (paymentDetails?: {
    receiptNumber: string;
    paymentId: string;
    contactEmail: string;
    contactName: string;
    amount: number;
  }) => void;
}

const toCents = (n: number) => Math.round((n || 0) * 100);

/**
 * Deterministic idempotency key. Same intent (customer, allocation set,
 * total, date, deposit account) → same key, so a double submit or a retry
 * after a network timeout collapses onto one payment server-side.
 */
export function makeCustomerPaymentRequestId(input: {
  contactId: string;
  allocations: Array<{ invoice_id: string; amount: number }>;
  totalCents: number;
  paymentDate: string;
  depositAccountId: string;
}): string {
  const alloc = [...input.allocations]
    .map((a) => `${a.invoice_id}:${toCents(a.amount)}`)
    .sort()
    .join("|");
  return `rcv-${input.contactId}-${input.paymentDate}-${input.totalCents}-${
    input.depositAccountId || "none"
  }-${alloc || "unapplied"}`;
}

export function RecordCustomerPaymentDialog({
  open,
  onOpenChange,
  invoice,
  preSelectedInvoiceId,
  preSelectedContactId,
  onSuccess,
  onPaymentRecorded,
}: RecordCustomerPaymentDialogProps) {
  const { recordMultiInvoicePayment, getPaymentsForInvoice } = usePayments();
  const { applyCreditToInvoice } = useCreditNotes();
  const { contacts } = useContacts();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();
  const { accounts: defaultAccounts } = useDefaultAccounts();
  const { accounts: allAccounts } = useAccounts();
  const showMpesa = isMpesaSupported(currentBusiness?.country ?? null);

  const focusedInvoiceId = invoice?.id ?? preSelectedInvoiceId ?? null;

  const [selectedContactId, setSelectedContactId] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [openInvoices, setOpenInvoices] = useState<OpenInvoice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split("T")[0]);
  const [paymentMethod, setPaymentMethod] = useState<string>("bank_transfer");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [depositAccountId, setDepositAccountId] = useState("");
  const [amountInput, setAmountInput] = useState<number | null>(null);
  const [history, setHistory] = useState<Payment[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [isApplyingCredit, setIsApplyingCredit] = useState(false);
  const [showReceiptPreview, setShowReceiptPreview] = useState(false);
  const [lastPaymentId, setLastPaymentId] = useState<string | null>(null);
  const [lastReceiptNumber, setLastReceiptNumber] = useState("");

  const assetAccounts = allAccounts.filter((a) => a.account_type === "asset" && a.is_active);

  const getDepositAccountForMethod = (method: string): string => {
    switch (method) {
      case "cash":
        return defaultAccounts.cash_account_id || defaultAccounts.bank_account_id || "";
      case "bank_transfer":
      case "check":
        return defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      case "credit_card":
        return (
          defaultAccounts.credit_card_clearing_id ||
          defaultAccounts.bank_account_id ||
          defaultAccounts.cash_account_id ||
          ""
        );
      case "mpesa":
        return (
          defaultAccounts.mpesa_account_id ||
          defaultAccounts.mobile_money_account_id ||
          defaultAccounts.bank_account_id ||
          defaultAccounts.cash_account_id ||
          ""
        );
      case "mobile_money":
        return (
          defaultAccounts.mobile_money_account_id ||
          defaultAccounts.bank_account_id ||
          defaultAccounts.cash_account_id ||
          ""
        );
      default:
        return defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
    }
  };

  const customers = useMemo(
    () => contacts.filter((c) => c.type === "customer" || c.type === "both"),
    [contacts],
  );

  const filteredCustomers = useMemo(() => {
    if (!customerSearch) return customers;
    const q = customerSearch.toLowerCase();
    return customers.filter(
      (c) => c.name.toLowerCase().includes(q) || c.company?.toLowerCase().includes(q),
    );
  }, [customers, customerSearch]);

  const selectedContact = useMemo(
    () => customers.find((c) => c.id === selectedContactId),
    [customers, selectedContactId],
  );

  const { credits, totalAvailableCredit, refetch: refetchCredits } = useCustomerCredits(
    open ? selectedContactId || null : null,
  );

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    const defaultMethod = "bank_transfer";
    setPaymentDate(new Date().toISOString().split("T")[0]);
    setPaymentMethod(defaultMethod);
    setReference("");
    setNotes("");
    setAllocations({});
    setAmountInput(null);
    setHistory([]);
    setDepositAccountId(getDepositAccountForMethod(defaultMethod));
    setCustomerSearch("");
    const contactFromInvoice = (invoice as any)?.contact_id ?? null;
    if (preSelectedContactId) setSelectedContactId(preSelectedContactId);
    else if (contactFromInvoice) setSelectedContactId(contactFromInvoice);
    else if (!focusedInvoiceId) {
      setSelectedContactId("");
      setOpenInvoices([]);
    }
  }, [open, preSelectedContactId, focusedInvoiceId, (invoice as any)?.contact_id]);

  useEffect(() => {
    setDepositAccountId(getDepositAccountForMethod(paymentMethod));
  }, [paymentMethod, defaultAccounts]);

  // Resolve the customer from a focused invoice id when the caller gave no object.
  useEffect(() => {
    if (!open || !focusedInvoiceId || selectedContactId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("invoices")
        .select("contact_id")
        .eq("id", focusedInvoiceId)
        .single();
      if (!cancelled && data?.contact_id) setSelectedContactId(data.contact_id);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, focusedInvoiceId, selectedContactId]);

  // Open invoices come from the GL-gated AR projection — residual already nets
  // cash receipts and applied credit notes; no status list is involved.
  const loadOpenInvoices = useCallback(async () => {
    if (!selectedContactId || !currentOrg || !currentBusiness) {
      setOpenInvoices([]);
      setAllocations({});
      return;
    }
    setLoadingInvoices(true);
    try {
      const rows = await fetchOpenCustomerInvoices({
        orgId: currentOrg.id,
        businessId: currentBusiness.id,
        contactId: selectedContactId,
      });
      setOpenInvoices(rows);
      if (focusedInvoiceId) {
        const inv = rows.find((i) => i.id === focusedInvoiceId);
        setAllocations(inv ? { [inv.id]: inv.balance_due } : {});
      } else {
        setAllocations({});
      }
      setAmountInput(null);
    } catch (err: any) {
      console.error("Error fetching open invoices:", err);
      toast.error("Failed to load invoices", { description: normalizeError(err).message });
    } finally {
      setLoadingInvoices(false);
    }
  }, [selectedContactId, currentOrg?.id, currentBusiness?.id, focusedInvoiceId]);

  useEffect(() => {
    if (!open) return;
    loadOpenInvoices();
  }, [open, loadOpenInvoices]);

  // Payment history for the focused invoice (single-invoice context only).
  useEffect(() => {
    if (!open || !focusedInvoiceId) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    getPaymentsForInvoice(focusedInvoiceId)
      .then((rows) => !cancelled && setHistory(rows))
      .catch(() => !cancelled && setHistory([]))
      .finally(() => !cancelled && setLoadingHistory(false));
    return () => {
      cancelled = true;
    };
  }, [open, focusedInvoiceId]);

  const totalAllocated = useMemo(
    () => Object.values(allocations).reduce((sum, v) => sum + (v || 0), 0),
    [allocations],
  );
  const totalOutstanding = useMemo(
    () => openInvoices.reduce((sum, inv) => sum + inv.balance_due, 0),
    [openInvoices],
  );

  const paymentAmount = amountInput ?? totalAllocated;
  const overpaymentAmount = Math.max(0, paymentAmount - totalAllocated);
  const currency = openInvoices[0]?.currency ?? (invoice as any)?.currency;

  const handleAllocationChange = useCallback((invoiceId: string, value: number) => {
    setAllocations((prev) => {
      if (value <= 0) {
        const next = { ...prev };
        delete next[invoiceId];
        return next;
      }
      return { ...prev, [invoiceId]: value };
    });
    setAmountInput(null);
  }, []);

  const handlePayFullBalance = useCallback(() => {
    const next: Record<string, number> = {};
    for (const inv of openInvoices) next[inv.id] = inv.balance_due;
    setAllocations(next);
    setAmountInput(null);
  }, [openInvoices]);

  const handleClearAll = useCallback(() => {
    setAllocations({});
    setAmountInput(null);
  }, []);

  const handleApplyCredit = async (creditNoteId: string, amount: number, targetInvoiceId: string) => {
    setIsApplyingCredit(true);
    try {
      await applyCreditToInvoice(creditNoteId, targetInvoiceId, amount, "Applied from payment dialog");
      toast.success("Credit applied");
      refetchCredits();
      await loadOpenInvoices();
      onSuccess?.();
    } catch (error: any) {
      toast.error("Error applying credit", { description: normalizeError(error).message });
    } finally {
      setIsApplyingCredit(false);
    }
  };

  const invoicesToPay = useMemo(
    () =>
      openInvoices
        .filter((inv) => (allocations[inv.id] ?? 0) > 0)
        .map((inv) => ({ invoice_id: inv.id, amount: allocations[inv.id] })),
    [openInvoices, allocations],
  );

  const requestId = useMemo(
    () =>
      makeCustomerPaymentRequestId({
        contactId: selectedContactId,
        allocations: invoicesToPay,
        totalCents: toCents(paymentAmount),
        paymentDate,
        depositAccountId,
      }),
    [selectedContactId, invoicesToPay, paymentAmount, paymentDate, depositAccountId],
  );

  const handleSubmit = async () => {
    if (!selectedContactId) {
      toast.error("Please select a customer");
      return;
    }
    if (!depositAccountId) {
      toast.error("Please select a deposit account");
      return;
    }
    if (paymentAmount <= 0) {
      toast.error("Enter a payment amount");
      return;
    }
    if (invoicesToPay.length === 0 && overpaymentAmount <= 0) {
      toast.error("Please allocate payment to at least one invoice");
      return;
    }
    for (const inv of openInvoices) {
      const alloc = allocations[inv.id] ?? 0;
      if (alloc > inv.balance_due + 0.01) {
        toast.error(`Allocation for ${inv.invoice_number} exceeds balance due`);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const result = await recordMultiInvoicePayment({
        contact_id: selectedContactId,
        allocations: invoicesToPay,
        total_amount: paymentAmount,
        payment_date: paymentDate,
        payment_method: paymentMethod as any,
        reference: reference || undefined,
        notes: notes || undefined,
        deposit_account_id: depositAccountId,
        requestId,
      });

      const excess = result.excess_amount || 0;
      toast.success(
        invoicesToPay.length <= 1
          ? `Payment of ${formatCurrency(paymentAmount, currency)} recorded`
          : `Payment allocated across ${invoicesToPay.length} invoices (${formatCurrency(paymentAmount, currency)})`,
        excess > 0
          ? { description: `${formatCurrency(excess, currency)} recorded as customer credit` }
          : undefined,
      );

      onOpenChange(false);
      onSuccess?.();
      onPaymentRecorded?.({
        receiptNumber: result.receipt_number || "",
        paymentId: result.id || "",
        contactEmail: selectedContact?.email || "",
        contactName: selectedContact?.name || "",
        amount: paymentAmount,
      });

      if (result.id) {
        setLastPaymentId(result.id);
        setLastReceiptNumber(result.receipt_number || `RCP-${Date.now()}`);
        setShowReceiptPreview(true);
      }
    } catch (error: any) {
      const normalized = normalizeError(error);
      toast.error(normalized.title, { description: normalized.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedDepositAccount = assetAccounts.find((a) => a.id === depositAccountId);
  const depositAccountLabel = selectedDepositAccount
    ? `${selectedDepositAccount.code} - ${selectedDepositAccount.name}`
    : "Not selected";

  const creditTargetInvoiceId =
    focusedInvoiceId && openInvoices.some((i) => i.id === focusedInvoiceId)
      ? focusedInvoiceId
      : openInvoices[0]?.id ?? null;
  const creditTargetBalance =
    openInvoices.find((i) => i.id === creditTargetInvoiceId)?.balance_due ?? 0;

  return (
    <>
      <DetailSheet
        open={open}
        onOpenChange={onOpenChange}
        size="md"
        title="Receive Payment"
        description="Select a customer, then allocate payment across their open invoices"
        footer={
          <FooterActionBar
            anchor="sheet"
            leading={
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            }
            trailing={
              <Button
                onClick={handleSubmit}
                disabled={isSubmitting || paymentAmount <= 0 || !depositAccountId}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Record Payment ({formatCurrency(paymentAmount, currency)})
              </Button>
            }
          />
        }
      >
        <div className="space-y-5">
          <FieldGroup label="Customer">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" />
                Customer *
              </Label>
              <div className="space-y-1.5">
                <Input
                  placeholder="Search customers..."
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                />
                <Select value={selectedContactId} onValueChange={setSelectedContactId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select customer" />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredCustomers.length === 0 ? (
                      <div className="py-2 px-3 text-sm text-muted-foreground">
                        No customers found
                      </div>
                    ) : (
                      filteredCustomers.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} {c.company && `(${c.company})`}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </FieldGroup>

          {/* Available customer credits */}
          {totalAvailableCredit > 0 && creditTargetInvoiceId && (
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Gift className="h-4 w-4 text-primary" />
                  <span>
                    Customer has {formatCurrency(totalAvailableCredit, currency)} available credit
                  </span>
                </div>
                <div className="space-y-1.5">
                  {credits.map((credit) => {
                    const applyAmount = Math.min(credit.available, creditTargetBalance);
                    return (
                      <div
                        key={credit.id}
                        className="flex items-center justify-between text-xs rounded border border-border bg-background px-3 py-2"
                      >
                        <div>
                          <span className="font-mono">{credit.credit_note_number}</span>
                          <span className="text-muted-foreground ml-2">
                            {formatCurrency(credit.available, currency)} available
                          </span>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={isApplyingCredit || applyAmount <= 0}
                          onClick={() =>
                            handleApplyCredit(credit.id, applyAmount, creditTargetInvoiceId)
                          }
                        >
                          {isApplyingCredit ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <>
                              <Zap className="h-3 w-3 mr-1" />
                              Apply {formatCurrency(applyAmount, currency)}
                            </>
                          )}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Payment history for the focused invoice */}
          {focusedInvoiceId && (loadingHistory || history.length > 0) && (
            <FieldGroup label="Payment History">
              {loadingHistory ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading history…
                </div>
              ) : (
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {history.map((p) => (
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
              )}
            </FieldGroup>
          )}

          {selectedContactId && (
            <FieldGroup label="Open Invoices">
              <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
                <Label className="flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  Open Invoices
                  {openInvoices.length > 0 && (
                    <Badge variant="secondary" className="ml-1.5 text-xs">
                      {openInvoices.length}
                    </Badge>
                  )}
                </Label>
                <div className="flex gap-1.5 flex-wrap">
                  {openInvoices.length > 0 && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handlePayFullBalance}
                        className="text-xs"
                      >
                        Pay All ({formatCurrency(totalOutstanding, currency)})
                      </Button>
                      {Object.keys(allocations).length > 0 && (
                        <Button type="button" variant="ghost" size="sm" onClick={handleClearAll}>
                          Clear
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {loadingInvoices ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : openInvoices.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-center justify-center py-6 text-center">
                    <FileText className="h-8 w-8 text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">
                      {selectedContact?.name || "This customer"} has no open invoices — any amount
                      recorded here becomes customer credit.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <>
                  {/* Mobile */}
                  <div className="sm:hidden flex flex-col gap-2">
                    {openInvoices.map((inv) => {
                      const isOverdue = new Date(inv.due_date) < new Date();
                      return (
                        <div key={inv.id} className="border rounded-md p-3 space-y-2 bg-card">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-medium text-sm truncate">
                                  {inv.invoice_number}
                                </span>
                                {isOverdue && (
                                  <Badge variant="destructive" className="text-[10px] px-1 py-0">
                                    Overdue
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {format(new Date(inv.issue_date), "MMM d")} · Due{" "}
                                <span className={isOverdue ? "text-destructive font-medium" : ""}>
                                  {format(new Date(inv.due_date), "MMM d")}
                                </span>
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-sm font-semibold text-primary">
                                {formatCurrency(inv.balance_due, inv.currency)}
                              </p>
                              <p className="text-[11px] text-muted-foreground">
                                of {formatCurrency(inv.total, inv.currency)}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              max={inv.balance_due}
                              value={allocations[inv.id] || ""}
                              onChange={(e) =>
                                handleAllocationChange(inv.id, parseFloat(e.target.value) || 0)
                              }
                              className="h-9 flex-1 min-w-0 text-right text-sm"
                              placeholder="0.00"
                              inputMode="decimal"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-9 px-2 text-xs shrink-0"
                              onClick={() => handleAllocationChange(inv.id, inv.balance_due)}
                            >
                              Full
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Desktop */}
                  <div className="hidden sm:block border rounded-md overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Invoice</TableHead>
                          <TableHead className="hidden md:table-cell">Date</TableHead>
                          <TableHead>Due</TableHead>
                          <TableHead className="text-right hidden lg:table-cell">Total</TableHead>
                          <TableHead className="text-right">Balance</TableHead>
                          <TableHead className="text-right">Payment</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {openInvoices.map((inv) => {
                          const isOverdue = new Date(inv.due_date) < new Date();
                          return (
                            <TableRow key={inv.id}>
                              <TableCell className="font-medium text-sm">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {inv.invoice_number}
                                  {isOverdue && (
                                    <Badge variant="destructive" className="text-[10px] px-1 py-0">
                                      Overdue
                                    </Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground hidden md:table-cell">
                                {format(new Date(inv.issue_date), "MMM d")}
                              </TableCell>
                              <TableCell
                                className={`text-xs ${isOverdue ? "text-destructive font-medium" : "text-muted-foreground"}`}
                              >
                                {format(new Date(inv.due_date), "MMM d")}
                              </TableCell>
                              <TableCell className="text-right text-sm hidden lg:table-cell">
                                {formatCurrency(inv.total, inv.currency)}
                              </TableCell>
                              <TableCell className="text-right text-sm font-semibold text-primary whitespace-nowrap">
                                {formatCurrency(inv.balance_due, inv.currency)}
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <Input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    max={inv.balance_due}
                                    value={allocations[inv.id] || ""}
                                    onChange={(e) =>
                                      handleAllocationChange(inv.id, parseFloat(e.target.value) || 0)
                                    }
                                    className="h-8 w-20 md:w-24 text-right text-sm"
                                    placeholder="0.00"
                                    inputMode="decimal"
                                  />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 px-2 text-xs"
                                    onClick={() => handleAllocationChange(inv.id, inv.balance_due)}
                                  >
                                    Full
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </FieldGroup>
          )}

          {selectedContactId && (
            <FieldGroup label="Payment Details">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Payment Date</Label>
                  <Input
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Payment Method</Label>
                  <Select value={paymentMethod} onValueChange={setPaymentMethod}>
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

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Amount Received *</Label>
                  {amountInput !== null && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto py-0.5 px-2 text-xs"
                      onClick={() => setAmountInput(null)}
                    >
                      Match allocation
                    </Button>
                  )}
                </div>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={amountInput ?? totalAllocated ?? 0}
                  onChange={(e) => setAmountInput(parseFloat(e.target.value) || 0)}
                  inputMode="decimal"
                />
                <p className="text-xs text-muted-foreground">
                  Anything above the allocated total is held as customer credit.
                </p>
              </div>

              <div className="space-y-1.5">
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
              <div className="space-y-1.5">
                <Label>Reference</Label>
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Transaction reference or check number"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Notes</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Additional notes..."
                  rows={2}
                />
              </div>

              <Card
                className={`border-dashed ${overpaymentAmount > 0 ? "border-amber-400 bg-amber-50/50 dark:bg-amber-950/20" : "border-primary/30 bg-primary/5"}`}
              >
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">Payment Summary</span>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-primary">
                        {formatCurrency(paymentAmount, currency)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        across {invoicesToPay.length} invoice(s)
                      </p>
                    </div>
                  </div>
                  <div className="border-t border-primary/20 pt-2 space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">
                      Journal Entry Preview
                    </p>
                    <div className="grid grid-cols-[1fr_auto] gap-1 text-xs text-muted-foreground pl-2">
                      <span>Dr {depositAccountLabel}</span>
                      <span className="text-right font-mono">
                        {formatCurrency(paymentAmount, currency)}
                      </span>
                      <span>Cr Accounts Receivable</span>
                      <span className="text-right font-mono">
                        {formatCurrency(totalAllocated, currency)}
                      </span>
                      {overpaymentAmount > 0 && (
                        <>
                          <span>Cr Customer Deposits</span>
                          <span className="text-right font-mono">
                            {formatCurrency(overpaymentAmount, currency)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  {overpaymentAmount > 0 && (
                    <div className="flex items-start gap-2 text-sm border-t border-amber-300/50 pt-2">
                      <Gift className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-medium text-amber-700 dark:text-amber-400">
                          Overpayment of {formatCurrency(overpaymentAmount, currency)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Held as customer credit and applicable to future invoices.
                        </p>
                      </div>
                    </div>
                  )}
                  {overpaymentAmount === 0 &&
                    totalAllocated >= totalOutstanding - 0.01 &&
                    openInvoices.length > 0 && (
                      <div className="pt-2 border-t border-primary/20">
                        <p className="text-xs text-green-600 font-medium flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          All outstanding balances will be fully paid
                        </p>
                      </div>
                    )}
                </CardContent>
              </Card>
            </FieldGroup>
          )}
        </div>
      </DetailSheet>

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

export default RecordCustomerPaymentDialog;
