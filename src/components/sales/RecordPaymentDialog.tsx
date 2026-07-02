import { useState, useEffect, useMemo, useCallback } from "react";
import { usePayments } from "@/hooks/usePayments";
import { useContacts } from "@/hooks/useContacts";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useAccounts } from "@/hooks/useAccounts";
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
import { Loader2, ArrowRight, User, FileText, CheckCircle2, Landmark } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { normalizeError } from "@/services/resilience";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { FieldGroup } from "@/design-system/primitives/FieldGrid";

interface OpenInvoice {
  id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  total: number;
  amount_paid: number;
  balance_due: number;
  currency: string;
  status: string;
  contact_id: string;
}

interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaymentRecorded?: (paymentDetails?: { receiptNumber: string; paymentId: string; contactEmail: string; contactName: string; amount: number }) => void;
  preSelectedInvoiceId?: string;
  preSelectedContactId?: string;
}

export function RecordPaymentDialog({
  open,
  onOpenChange,
  onPaymentRecorded,
  preSelectedInvoiceId,
  preSelectedContactId,
}: RecordPaymentDialogProps) {
  const { recordPayment, recordMultiInvoicePayment } = usePayments();
  const { contacts } = useContacts();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency } = useCurrency();
  const { accounts: defaultAccounts } = useDefaultAccounts();
  const { accounts: allAccounts } = useAccounts();
  const showMpesa = isMpesaSupported(currentBusiness?.country ?? null);

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

  const assetAccounts = allAccounts.filter(a => a.account_type === "asset" && a.is_active);

  const getDepositAccountForMethod = (method: string): string => {
    switch (method) {
      case "cash": return defaultAccounts.cash_account_id || defaultAccounts.bank_account_id || "";
      case "bank_transfer":
      case "check": return defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      case "credit_card": return defaultAccounts.credit_card_clearing_id || defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      case "mpesa": return defaultAccounts.mpesa_account_id || defaultAccounts.mobile_money_account_id || defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      case "mobile_money": return defaultAccounts.mobile_money_account_id || defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
      default: return defaultAccounts.bank_account_id || defaultAccounts.cash_account_id || "";
    }
  };

  const customers = useMemo(() => contacts.filter((c) => c.type === "customer" || c.type === "both"), [contacts]);

  const filteredCustomers = useMemo(() => {
    if (!customerSearch) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(customerSearch.toLowerCase()) ||
        c.company?.toLowerCase().includes(customerSearch.toLowerCase())
    );
  }, [customers, customerSearch]);

  const selectedContact = useMemo(() => customers.find((c) => c.id === selectedContactId), [customers, selectedContactId]);

  useEffect(() => {
    if (open) {
      const defaultMethod = "bank_transfer";
      setPaymentDate(new Date().toISOString().split("T")[0]);
      setPaymentMethod(defaultMethod);
      setReference("");
      setNotes("");
      setAllocations({});
      setDepositAccountId(getDepositAccountForMethod(defaultMethod));
      if (preSelectedContactId) {
        setSelectedContactId(preSelectedContactId);
      } else if (preSelectedInvoiceId) {
        // will be set after loading invoice
      } else {
        setSelectedContactId("");
        setOpenInvoices([]);
      }
      setCustomerSearch("");
    }
  }, [open, preSelectedContactId, preSelectedInvoiceId]);

  useEffect(() => {
    setDepositAccountId(getDepositAccountForMethod(paymentMethod));
  }, [paymentMethod, defaultAccounts]);

  useEffect(() => {
    if (!selectedContactId || !currentOrg || !currentBusiness) {
      setOpenInvoices([]);
      setAllocations({});
      return;
    }
    const fetchInvoices = async () => {
      setLoadingInvoices(true);
      try {
        const { data, error } = await supabase
          .from("invoices")
          .select("id, invoice_number, issue_date, due_date, total, amount_paid, currency, status, contact_id")
          .eq("organization_id", currentOrg.id)
          .eq("business_id", currentBusiness.id)
          .eq("contact_id", selectedContactId)
          .in("status", ["sent", "partial", "overdue"])
          .order("due_date", { ascending: true });
        if (error) throw error;
        const invoices: OpenInvoice[] = (data || []).map((inv) => ({ ...inv, amount_paid: inv.amount_paid || 0, balance_due: inv.total - (inv.amount_paid || 0) }));
        setOpenInvoices(invoices);
        if (preSelectedInvoiceId) {
          const inv = invoices.find((i) => i.id === preSelectedInvoiceId);
          if (inv) setAllocations({ [inv.id]: inv.balance_due });
        } else {
          setAllocations({});
        }
      } catch (err: any) {
        console.error("Error fetching invoices:", err);
        toast.error("Failed to load invoices");
      } finally {
        setLoadingInvoices(false);
      }
    };
    fetchInvoices();
  }, [selectedContactId, currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    if (!open || !preSelectedInvoiceId || selectedContactId) return;
    const findCustomer = async () => {
      const { data } = await supabase.from("invoices").select("contact_id").eq("id", preSelectedInvoiceId).single();
      if (data?.contact_id) setSelectedContactId(data.contact_id);
    };
    findCustomer();
  }, [open, preSelectedInvoiceId]);

  const totalAllocated = useMemo(() => Object.values(allocations).reduce((sum, val) => sum + (val || 0), 0), [allocations]);
  const totalOutstanding = useMemo(() => openInvoices.reduce((sum, inv) => sum + inv.balance_due, 0), [openInvoices]);

  const handleAllocationChange = useCallback((invoiceId: string, value: number) => {
    setAllocations((prev) => {
      if (value <= 0) { const next = { ...prev }; delete next[invoiceId]; return next; }
      return { ...prev, [invoiceId]: value };
    });
  }, []);

  const handlePayFullBalance = useCallback(() => {
    const newAlloc: Record<string, number> = {};
    for (const inv of openInvoices) newAlloc[inv.id] = inv.balance_due;
    setAllocations(newAlloc);
  }, [openInvoices]);

  const handleClearAll = useCallback(() => setAllocations({}), []);

  const handleSubmit = async () => {
    if (!selectedContactId) { toast.error("Please select a customer"); return; }
    if (!depositAccountId) { toast.error("Please select a deposit account"); return; }
    const invoicesToPay = openInvoices.filter((inv) => allocations[inv.id] && allocations[inv.id] > 0);
    if (invoicesToPay.length === 0) { toast.error("Please allocate payment to at least one invoice"); return; }
    for (const inv of invoicesToPay) {
      if (allocations[inv.id] > inv.balance_due + 0.01) { toast.error(`Allocation for ${inv.invoice_number} exceeds balance due`); return; }
    }
    setIsSubmitting(true);
    try {
      let lastPaymentResult: any = null;
      if (invoicesToPay.length === 1) {
        const inv = invoicesToPay[0];
        lastPaymentResult = await recordPayment({ invoice_id: inv.id, amount: allocations[inv.id], payment_date: paymentDate, payment_method: paymentMethod as any, reference: reference || undefined, notes: notes || undefined, deposit_account_id: depositAccountId });
      } else {
        lastPaymentResult = await recordMultiInvoicePayment({ contact_id: selectedContactId, allocations: invoicesToPay.map(inv => ({ invoice_id: inv.id, amount: allocations[inv.id] })), total_amount: totalAllocated, payment_date: paymentDate, payment_method: paymentMethod as any, reference: reference || undefined, notes: notes || undefined, deposit_account_id: depositAccountId });
      }
      toast.success(invoicesToPay.length === 1 ? `Payment of ${formatCurrency(totalAllocated)} recorded` : `Payment allocated across ${invoicesToPay.length} invoices (${formatCurrency(totalAllocated)})`);
      onOpenChange(false);
      const contact = customers.find(c => c.id === selectedContactId);
      onPaymentRecorded?.({ receiptNumber: lastPaymentResult?.receipt_number || "", paymentId: lastPaymentResult?.id || "", contactEmail: contact?.email || "", contactName: contact?.name || "", amount: totalAllocated });
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to record payment");
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedDepositAccount = assetAccounts.find(a => a.id === depositAccountId);
  const depositAccountLabel = selectedDepositAccount ? `${selectedDepositAccount.code} - ${selectedDepositAccount.name}` : "Not selected";

  return (
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
            <Button onClick={handleSubmit} disabled={isSubmitting || totalAllocated <= 0 || !depositAccountId}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record Payment ({formatCurrency(totalAllocated)})
            </Button>
          }
        />
      }
    >
      <div className="space-y-5">
        <FieldGroup label="Customer">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5"><User className="h-3.5 w-3.5" />Customer *</Label>
            <div className="space-y-1.5">
              <Input placeholder="Search customers..." value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} />
              <Select value={selectedContactId} onValueChange={setSelectedContactId}>
                <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                <SelectContent>
                  {filteredCustomers.length === 0 ? (
                    <div className="py-2 px-3 text-sm text-muted-foreground">No customers found</div>
                  ) : (
                    filteredCustomers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name} {c.company && `(${c.company})`}</SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
        </FieldGroup>

        {selectedContactId && (
          <FieldGroup label="Open Invoices">
            <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
              <Label className="flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5" />
                Open Invoices
                {openInvoices.length > 0 && <Badge variant="secondary" className="ml-1.5 text-xs">{openInvoices.length}</Badge>}
              </Label>
              <div className="flex gap-1.5 flex-wrap">
                {openInvoices.length > 0 && (
                  <>
                    <Button type="button" variant="outline" size="sm" onClick={handlePayFullBalance} className="text-xs">Pay All ({formatCurrency(totalOutstanding)})</Button>
                    {Object.keys(allocations).length > 0 && <Button type="button" variant="ghost" size="sm" onClick={handleClearAll}>Clear</Button>}
                  </>
                )}
              </div>
            </div>
            {loadingInvoices ? (
              <div className="flex items-center justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : openInvoices.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-6 text-center">
                  <FileText className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">{selectedContact?.name || "This customer"} has no open invoices</p>
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
                              <span className="font-medium text-sm truncate">{inv.invoice_number}</span>
                              {isOverdue && <Badge variant="destructive" className="text-[10px] px-1 py-0">Overdue</Badge>}
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {format(new Date(inv.issue_date), "MMM d")} · Due{" "}
                              <span className={isOverdue ? "text-destructive font-medium" : ""}>{format(new Date(inv.due_date), "MMM d")}</span>
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-semibold text-primary">{formatCurrency(inv.balance_due, inv.currency)}</p>
                            <p className="text-[11px] text-muted-foreground">of {formatCurrency(inv.total, inv.currency)}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Input type="number" step="0.01" min="0" max={inv.balance_due} value={allocations[inv.id] || ""} onChange={(e) => handleAllocationChange(inv.id, parseFloat(e.target.value) || 0)} className="h-9 flex-1 min-w-0 text-right text-sm" placeholder="0.00" inputMode="decimal" />
                          <Button type="button" variant="outline" size="sm" className="h-9 px-2 text-xs shrink-0" onClick={() => handleAllocationChange(inv.id, inv.balance_due)}>Full</Button>
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
                                {isOverdue && <Badge variant="destructive" className="text-[10px] px-1 py-0">Overdue</Badge>}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground hidden md:table-cell">{format(new Date(inv.issue_date), "MMM d")}</TableCell>
                            <TableCell className={`text-xs ${isOverdue ? "text-destructive font-medium" : "text-muted-foreground"}`}>{format(new Date(inv.due_date), "MMM d")}</TableCell>
                            <TableCell className="text-right text-sm hidden lg:table-cell">{formatCurrency(inv.total, inv.currency)}</TableCell>
                            <TableCell className="text-right text-sm font-semibold text-primary whitespace-nowrap">{formatCurrency(inv.balance_due, inv.currency)}</TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                <Input type="number" step="0.01" min="0" max={inv.balance_due} value={allocations[inv.id] || ""} onChange={(e) => handleAllocationChange(inv.id, parseFloat(e.target.value) || 0)} className="h-8 w-20 md:w-24 text-right text-sm" placeholder="0.00" inputMode="decimal" />
                                <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => handleAllocationChange(inv.id, inv.balance_due)}>Full</Button>
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

        {totalAllocated > 0 && (
          <FieldGroup label="Payment Details">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Payment Date</Label>
                <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Payment Method</Label>
                <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
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
              <Label className="flex items-center gap-1.5"><Landmark className="h-3.5 w-3.5" />Deposit To *</Label>
              <AccountCombobox accounts={assetAccounts} value={depositAccountId} onValueChange={setDepositAccountId} placeholder="Select deposit account..." />
              <p className="text-xs text-muted-foreground">The GL account that will be debited for this payment</p>
            </div>
            <div className="space-y-1.5">
              <Label>Reference</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transaction reference or check number" />
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Additional notes..." rows={2} />
            </div>
            <Card className="border-dashed border-primary/30 bg-primary/5">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Payment Summary</span>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-primary">{formatCurrency(totalAllocated)}</p>
                    <p className="text-xs text-muted-foreground">across {Object.keys(allocations).filter((k) => allocations[k] > 0).length} invoice(s)</p>
                  </div>
                </div>
                <div className="border-t border-primary/20 pt-2 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Journal Entry Preview</p>
                  <div className="grid grid-cols-[1fr_auto] gap-1 text-xs text-muted-foreground pl-2">
                    <span>Dr {depositAccountLabel}</span>
                    <span className="text-right font-mono">{formatCurrency(totalAllocated)}</span>
                    <span>Cr Accounts Receivable</span>
                    <span className="text-right font-mono">{formatCurrency(totalAllocated)}</span>
                  </div>
                </div>
                {totalAllocated >= totalOutstanding - 0.01 && openInvoices.length > 0 && (
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
  );
}
