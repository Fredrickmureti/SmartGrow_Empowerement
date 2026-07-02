/**
 * ADR 0012 — Wave R3.
 *
 * ApplyCustomerDepositDialog: guided UI for applying customer cash that
 * is currently parked on the Customer Deposits liability account to a
 * specific open invoice.
 *
 * This is the ONLY supported UI path to consume an unapplied deposit
 * besides issuing a refund. It wraps `apply_customer_deposit_atomic`
 * via `useTransactionReversal().applyCustomerDeposit` which posts:
 *
 *   DR  Accounts Receivable     <amount>
 *   CR  Customer Deposits       <amount>
 *
 * and updates `payments.outstanding_amount` / `invoices.amount_paid`
 * atomically. Idempotent on `client_request_id`.
 */
import { useEffect, useMemo, useState } from "react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Banknote, ArrowDown } from "lucide-react";
import { useTransactionReversal } from "@/hooks/useTransactionReversal";
import { useCurrency } from "@/hooks/useCurrency";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCustomerUnappliedDeposits } from "@/hooks/useCustomerUnappliedDeposits";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";

interface ApplyCustomerDepositDialogProps {
  /** Customer to scope deposits + invoices to. */
  contactId: string | null;
  /** Optional: pre-select a deposit (payment id). */
  initialPaymentId?: string;
  /** Optional: pre-select an invoice. */
  initialInvoiceId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface OpenInvoice {
  id: string;
  invoice_number: string;
  total: number;
  amount_paid: number;
  balance: number;
  issue_date: string;
}

export function ApplyCustomerDepositDialog({
  contactId,
  initialPaymentId,
  initialInvoiceId,
  open,
  onOpenChange,
  onSuccess,
}: ApplyCustomerDepositDialogProps) {
  const { formatCurrency } = useCurrency();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { applyCustomerDeposit } = useTransactionReversal();
  const queryClient = useQueryClient();

  const { deposits, isLoading: depositsLoading } =
    useCustomerUnappliedDeposits(contactId);

  const [paymentId, setPaymentId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState<string>("");
  const [applyDate, setApplyDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [submitting, setSubmitting] = useState(false);

  // Reset on open + apply initial selection
  useEffect(() => {
    if (!open) return;
    setPaymentId(
      initialPaymentId ?? (deposits.length === 1 ? deposits[0].id : ""),
    );
    setInvoiceId(initialInvoiceId ?? "");
    setAmount("");
    setApplyDate(new Date().toISOString().slice(0, 10));
  }, [open, initialPaymentId, initialInvoiceId, deposits.length]);

  const selectedDeposit = useMemo(
    () => deposits.find((d) => d.id === paymentId) ?? null,
    [deposits, paymentId],
  );

  // Open invoices for this customer (same business). No currency column on
  // payments/invoices today — base_currency is uniform per business.
  const { data: invoices = [], isLoading: invoicesLoading } = useQuery({
    queryKey: ["open-invoices-for-deposit", contactId, currentOrg?.id, currentBusiness?.id],
    queryFn: async (): Promise<OpenInvoice[]> => {
      if (!contactId || !currentOrg?.id || !currentBusiness?.id) return [];
      const { data, error } = await supabase
        .from("invoices")
        .select("id, invoice_number, total, amount_paid, issue_date, status")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("contact_id", contactId)
        .in("status", ["sent", "viewed", "partial", "overdue"])
        .order("issue_date", { ascending: true });
      if (error) throw error;
      return (data ?? [])
        .map((i: any) => ({
          id: i.id,
          invoice_number: i.invoice_number,
          total: Number(i.total) || 0,
          amount_paid: Number(i.amount_paid) || 0,
          balance: (Number(i.total) || 0) - (Number(i.amount_paid) || 0),
          issue_date: i.issue_date,
        }))
        .filter((i) => i.balance > 0);
    },
    enabled: open && !!contactId && !!currentOrg?.id && !!currentBusiness?.id,
    staleTime: 15_000,
  });

  const selectedInvoice = useMemo(
    () => invoices.find((i) => i.id === invoiceId) ?? null,
    [invoices, invoiceId],
  );

  // Hard cap: min(outstanding deposit, invoice balance).
  const maxApplicable = useMemo(() => {
    if (!selectedDeposit || !selectedInvoice) return 0;
    return Math.min(selectedDeposit.outstanding_amount, selectedInvoice.balance);
  }, [selectedDeposit, selectedInvoice]);

  // Auto-default amount when both are picked.
  useEffect(() => {
    if (maxApplicable > 0 && amount === "") {
      setAmount(maxApplicable.toFixed(2));
    }
  }, [maxApplicable, amount]);

  const numericAmount = Number(amount) || 0;
  const overCap = numericAmount > maxApplicable + 0.005;
  const validAmount = numericAmount > 0 && !overCap;

  const canSubmit =
    !!selectedDeposit &&
    !!selectedInvoice &&
    validAmount &&
    !!applyDate &&
    !submitting;

  const clientRequestId = useMemo(() => {
    if (!selectedDeposit || !selectedInvoice || !validAmount) return undefined;
    const cents = Math.round(numericAmount * 100);
    return `apply-${selectedDeposit.id}-${selectedInvoice.id}-${cents}`;
  }, [selectedDeposit, selectedInvoice, numericAmount, validAmount]);

  const handleSubmit = async () => {
    if (!canSubmit || !selectedDeposit || !selectedInvoice) return;
    setSubmitting(true);
    try {
      const ok = await applyCustomerDeposit({
        paymentId: selectedDeposit.id,
        invoiceId: selectedInvoice.id,
        amount: numericAmount,
        applyDate,
        clientRequestId,
      });
      if (ok) {
        // Invalidate every read model affected.
        queryClient.invalidateQueries({ queryKey: ["customer-unapplied-deposits"] });
        queryClient.invalidateQueries({ queryKey: ["customer-outstanding-balance"] });
        queryClient.invalidateQueries({ queryKey: ["invoices"] });
        queryClient.invalidateQueries({ queryKey: ["invoice", selectedInvoice.id] });
        queryClient.invalidateQueries({ queryKey: ["payments"] });
        queryClient.invalidateQueries({ queryKey: ["open-invoices-for-deposit"] });
        onOpenChange(false);
        onSuccess?.();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={(o) => !submitting && onOpenChange(o)}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Banknote className="h-5 w-5 text-primary" />
          Apply Customer Deposit to Invoice
        </span>
      }
      description="Move money already received from this customer off the Customer Deposits liability and onto a specific open invoice."
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
          }
          trailing={
            <Button onClick={handleSubmit} disabled={!canSubmit}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Apply Deposit
            </Button>
          }
        />
      }
    >


        {depositsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : deposits.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            This customer has no unapplied deposits.
          </div>
        ) : (
          <div className="space-y-4">
            {/* Step 1 — pick deposit */}
            <div className="space-y-2">
              <Label>Unapplied deposit</Label>
              <Select value={paymentId} onValueChange={setPaymentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a deposit…" />
                </SelectTrigger>
                <SelectContent>
                  {deposits.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      <span className="flex items-center justify-between gap-3 w-full">
                        <span>{d.receipt_number || `Payment ${d.id.slice(0, 8)}`}</span>
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(d.payment_date), "MMM d, yyyy")} ·{" "}
                          {formatCurrency(d.outstanding_amount)} available
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Step 2 — pick invoice */}
            <div className="space-y-2">
              <Label>Open invoice</Label>
              {invoicesLoading ? (
                <div className="flex items-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : invoices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This customer has no invoices with an outstanding balance.
                </p>
              ) : (
                <Select value={invoiceId} onValueChange={setInvoiceId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose an invoice…" />
                  </SelectTrigger>
                  <SelectContent>
                    {invoices.map((i) => (
                      <SelectItem key={i.id} value={i.id}>
                        <span className="flex items-center justify-between gap-3 w-full">
                          <span>{i.invoice_number}</span>
                          <span className="text-xs text-muted-foreground">
                            Balance {formatCurrency(i.balance)}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Step 3 — amount + date + preview */}
            {selectedDeposit && selectedInvoice && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="apply-amount">Amount to apply</Label>
                    <Input
                      id="apply-amount"
                      type="number"
                      step="0.01"
                      min="0"
                      max={maxApplicable}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Max {formatCurrency(maxApplicable)}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apply-date">Apply date</Label>
                    <Input
                      id="apply-date"
                      type="date"
                      value={applyDate}
                      onChange={(e) => setApplyDate(e.target.value)}
                    />
                  </div>
                </div>
                {overCap && (
                  <p className="text-xs text-destructive">
                    Amount exceeds the available deposit or invoice balance.
                  </p>
                )}

                {validAmount && (
                  <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
                    <div className="font-medium flex items-center gap-2">
                      <ArrowDown className="h-4 w-4" />
                      Accounting preview
                    </div>
                    <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-sm">
                      <span className="text-muted-foreground">DR Accounts Receivable</span>
                      <span className="text-right tabular-nums">{formatCurrency(numericAmount)}</span>
                      <span />
                      <span className="text-muted-foreground">CR Customer Deposits</span>
                      <span />
                      <span className="text-right tabular-nums">{formatCurrency(numericAmount)}</span>
                    </div>
                    <div className="pt-2 mt-2 border-t flex justify-between">
                      <span className="text-muted-foreground">Invoice balance after</span>
                      <span className="font-medium">
                        {formatCurrency(Math.max(0, selectedInvoice.balance - numericAmount))}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Deposit remaining after</span>
                      <span className="font-medium">
                        {formatCurrency(Math.max(0, selectedDeposit.outstanding_amount - numericAmount))}
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

    </DetailSheet>
  );
}

