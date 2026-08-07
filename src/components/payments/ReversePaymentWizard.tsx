import { useEffect, useMemo, useState } from "react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import {
  useTransactionReversal,
  type PaymentReversalReason,
} from "@/hooks/useTransactionReversal";
import { useCurrency } from "@/hooks/useCurrency";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Checkbox } from "@/components/ui/checkbox";
import { ReversalConsequencePreview } from "@/components/reversal/ReversalConsequencePreview";
import { useReversalConsequences } from "@/components/reversal/useReversalConsequences";


/**
 * ADR 0012 — Guided payment reversal.
 *
 * Three steps:
 *   1. "What happened?" — operator picks a plain-language reason that maps
 *      deterministically to one of {void, unapply, refund, credit_note}.
 *   2. "Preview" — shows the GL impact and the customer-balance delta.
 *   3. "Confirm" — reversal date + required note. A uuid `client_request_id`
 *      is generated up-front so retries are idempotent end-to-end.
 *
 * The wizard is the single UI entry point for reversal. Direct calls to
 * `voidPayment` / `unapplyPayment` / `refundCustomer` from screens are
 * being phased out (architecture test in P3 enforces this).
 */

export interface ReversePaymentWizardPayment {
  id: string;
  receipt_number: string;
  amount: number;
  outstanding_amount?: number | null;
  applied_amount?: number | null;
  payment_date: string;
  invoice?: { id?: string; invoice_number: string } | null;
}

interface ReversePaymentWizardProps {
  payment: ReversePaymentWizardPayment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /**
   * Optional pre-seeded reason code. When set, the wizard opens on step 2
   * with this reason already selected. Used by callers that replaced the
   * legacy UnreconcilePaymentDialog (always wrong_invoice_applied → unapply).
   */
  initialReasonCode?: PaymentReversalReason;
}

type ReversalOp = "void" | "unapply" | "refund" | "credit_note";

interface ReasonOption {
  code: PaymentReversalReason;
  label: string;
  helper: string;
  op: ReversalOp;
}

const REASON_OPTIONS: ReasonOption[] = [
  {
    code: "data_entry_error",
    label: "I entered this payment by mistake",
    helper:
      "The payment shouldn't exist at all. We'll reverse it fully — no cash, no credit.",
    op: "void",
  },
  {
    code: "duplicate_payment",
    label: "This is a duplicate of another payment",
    helper:
      "The same money was recorded twice. We'll reverse this copy fully.",
    op: "void",
  },
  {
    code: "bank_transfer_failed",
    label: "The bank transfer failed / bounced",
    helper:
      "The cash never actually reached the account. Full reversal — no credit owed.",
    op: "void",
  },
  {
    code: "wrong_invoice_applied",
    label: "I applied this to the wrong invoice",
    helper:
      "The cash is real, but it shouldn't be linked to this invoice. We'll free up the invoice and keep the cash as an unapplied advance.",
    op: "unapply",
  },
  {
    code: "customer_refund_requested",
    label: "The customer wants their money back",
    helper:
      "We'll pay the customer back out of a bank account. You'll choose which account on the next step.",
    op: "refund",
  },
  {
    code: "invoice_cancelled_keep_as_credit",
    label: "Invoice was cancelled — keep the money as a credit note",
    helper:
      "Issue the customer a credit note they can apply to future invoices.",
    op: "credit_note",
  },
  {
    code: "invoice_cancelled_keep_as_advance",
    label: "Invoice was cancelled — keep the money as an advance",
    helper:
      "Leave the cash sitting on the customer's account as an unapplied advance.",
    op: "unapply",
  },
];

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

/** Hash-style deterministic id so a double-click cannot double-spend. */
function makeDeterministicRequestId(
  paymentId: string,
  reasonCode: string,
  amountCents: number,
  bankAccountId: string,
): string {
  return `rev-${paymentId}-${reasonCode}-${amountCents}-${bankAccountId || "none"}`;
}

export function ReversePaymentWizard({
  payment,
  open,
  onOpenChange,
  onSuccess,
  initialReasonCode,
}: ReversePaymentWizardProps) {
  const { voidPayment, unapplyPayment, refundCustomer, issueCreditNoteForPayment } = useTransactionReversal();
  const { formatCurrency } = useCurrency();
  const { accounts: bankAccounts } = useBankAccounts();
  const { currentBusiness } = useBusinesses();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [reasonCode, setReasonCode] = useState<PaymentReversalReason | "">(initialReasonCode ?? "");
  const [reasonText, setReasonText] = useState("");
  const [reversalDate, setReversalDate] = useState<string>(todayISO());
  const [bankAccountId, setBankAccountId] = useState<string>("");
  const [refundAmount, setRefundAmount] = useState<string>("");
  // ADR 0012 R4 — explicit operator acknowledgement to unapply currently
  // applied cash before a refund. Defaults OFF. Cap stays at outstanding
  // until this is checked, preventing silent invoice-rebalancing.
  const [allowUnapplyForRefund, setAllowUnapplyForRefund] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Pre-seed the reason code (and skip step 1) when the wizard is opened
  // from a flow that already knows the intent — e.g. the legacy
  // "Un-reconcile" entry points always mean wrong_invoice_applied.
  useEffect(() => {
    if (open && initialReasonCode) {
      setReasonCode(initialReasonCode);
      setStep(2);
    }
  }, [open, initialReasonCode]);

  const selected = useMemo(
    () => REASON_OPTIONS.find((r) => r.code === reasonCode) ?? null,
    [reasonCode],
  );

  const reset = () => {
    setStep(initialReasonCode ? 2 : 1);
    setReasonCode(initialReasonCode ?? "");
    setReasonText("");
    setReversalDate(todayISO());
    setBankAccountId("");
    setRefundAmount("");
    setAllowUnapplyForRefund(false);
  };

  const close = (success?: boolean) => {
    reset();
    onOpenChange(false);
    if (success) onSuccess?.();
  };

  // NOTE: every hook must run unconditionally on every render. Do NOT
  // place hooks below the `if (!payment) return null` guard further down
  // — that is a Rules-of-Hooks violation and crashes /sales/payments
  // ("Rendered more hooks than during the previous render") the moment a
  // payment is selected. Pinned by
  // `src/test/architecture/payment-reversal-intent-contract.test.ts`.

  // Cross-currency guard (R4). Block when the chosen bank account's
  // currency differs from the business base currency. Cross-currency
  // refunds are deferred to ADR 0015 (FX revaluation on reversal).
  const selectedBank = useMemo(
    () => bankAccounts.find((b) => (b.account_id ?? b.id) === bankAccountId) ?? null,
    [bankAccounts, bankAccountId],
  );

  const refundAmountNumber = Number(refundAmount) || 0;
  const refundCents = Math.round(refundAmountNumber * 100);

  // Deterministic idempotency key — locked to payment + reason + amount + bank.
  const requestId = useMemo(
    () =>
      makeDeterministicRequestId(
        payment?.id ?? "no-payment",
        (selected?.code ?? "none") as string,
        selected?.op === "refund" ? refundCents : 0,
        selected?.op === "refund" ? bankAccountId : "",
      ),
    [payment?.id, selected?.code, selected?.op, refundCents, bankAccountId],
  );

  if (!payment) return null;

  const appliedAmount = Number(payment.applied_amount ?? payment.amount) || 0;
  const outstandingAmount = Number(payment.outstanding_amount ?? 0) || 0;

  // ADR 0012 R4 — default cap is the strictly unapplied portion. Operator
  // must check "also free $X from the linked invoice" to raise it.
  const refundCap =
    selected?.op === "refund"
      ? allowUnapplyForRefund
        ? outstandingAmount + appliedAmount
        : outstandingAmount > 0
          ? outstandingAmount
          : 0
      : 0;

  const baseCurrency = currentBusiness?.base_currency ?? null;
  const currencyMismatch =
    selected?.op === "refund" &&
    !!selectedBank?.currency &&
    !!baseCurrency &&
    selectedBank.currency !== baseCurrency;

  // Phase 2 — the confirmation step shows what the reversal would change before
  // the operator authorises it. Fetched once the wizard reaches step 3 so the
  // preview reflects the state at confirmation time, not at open time.
  const {
    consequences,
    isLoading: isPreviewLoading,
    isError: isPreviewError,
  } = useReversalConsequences("payment", payment?.id, open && step === 3);


  const handleSubmit = async () => {
    if (!selected || !reasonText.trim()) return;
    setSubmitting(true);
    try {
      let ok = false;
      if (selected.op === "credit_note") {
        ok = await issueCreditNoteForPayment({
          paymentId: payment.id,
          reason: reasonText.trim(),
          reversalDate,
          clientRequestId: requestId,
        });
      } else if (selected.op === "void") {
        ok = await voidPayment({
          paymentId: payment.id,
          reason: reasonText.trim(),
          voidDate: reversalDate,
          reasonCode: selected.code,
          clientRequestId: requestId,
        });
      } else if (selected.op === "unapply") {
        ok = await unapplyPayment({
          paymentId: payment.id,
          reason: reasonText.trim(),
          reasonCode: selected.code,
          reversalDate,
          clientRequestId: requestId,
        });
      } else if (selected.op === "refund") {
        const amt = Number(refundAmount);
        if (!bankAccountId) throw new Error("Pick a bank account to refund from.");
        if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter a refund amount.");
        if (currencyMismatch) {
          throw new Error(
            "Cross-currency refunds are not yet supported. Pick a bank account in the business base currency.",
          );
        }
        if (amt > refundCap) {
          throw new Error(
            allowUnapplyForRefund
              ? `Refund cannot exceed ${formatCurrency(refundCap)}.`
              : `Refund cannot exceed the currently unapplied ${formatCurrency(outstandingAmount)}. To refund more, tick "Also free cash from the linked invoice".`,
          );
        }
        // ADR 0012 R4 — only when the operator has explicitly opted in does
        // the wizard unapply currently applied cash before the refund.
        if (outstandingAmount < amt && appliedAmount > 0) {
          if (!allowUnapplyForRefund) {
            throw new Error(
              "This refund needs cash that is currently applied to an invoice. Tick the acknowledgement first.",
            );
          }
          const unapplied = await unapplyPayment({
            paymentId: payment.id,
            reason: `Unapply prior to refund: ${reasonText.trim()}`,
            reasonCode: "pre_refund_unapply",
            reversalDate,
            clientRequestId: `${requestId}-pre-unapply`,
          });
          if (!unapplied) throw new Error("Could not free up the cash before refunding.");
        }
        ok = await refundCustomer({
          source: "payment",
          sourceId: payment.id,
          bankAccountId,
          amount: amt,
          refundDate: reversalDate,
          reasonCode: selected.code,
          reason: reasonText.trim(),
          clientRequestId: requestId,
        });
      }
      if (ok) close(true);
    } catch (err: any) {
      // Toast surfaced by the hooks themselves; nothing more to do here.
      // eslint-disable-next-line no-console
      console.error("[ReversePaymentWizard]", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close(false))}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          Reverse Payment — Step {step} of 3
        </span>
      }
      description={
        <>
          Receipt <strong>{payment.receipt_number}</strong> ·{" "}
          {formatCurrency(payment.amount)} ·{" "}
          {payment.invoice ? `applied to ${payment.invoice.invoice_number}` : "unapplied"}
        </>
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            step > 1 ? (
              <Button
                variant="ghost"
                onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}
                disabled={submitting}
              >
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
            ) : null
          }
          trailing={
            <>
              <Button variant="outline" onClick={() => close(false)} disabled={submitting}>
                Cancel
              </Button>
              {step < 3 && (
                <Button
                  onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
                  disabled={
                    !reasonCode ||
                    (step === 2 &&
                      selected?.op === "refund" &&
                      (!bankAccountId ||
                        currencyMismatch ||
                        !refundAmount ||
                        Number(refundAmount) <= 0 ||
                        Number(refundAmount) > refundCap))
                  }
                >
                  Next <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              )}
              {step === 3 && (
                <Button
                  variant="destructive"
                  onClick={handleSubmit}
                  disabled={submitting || !reasonText.trim()}
                >
                  {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Confirm reversal
                </Button>
              )}
            </>
          }
        />
      }
    >


        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Pick what actually happened. We'll do the right accounting based on
              your answer — you don't need to know the GL details.
            </p>
            <RadioGroup
              value={reasonCode}
              onValueChange={(v) => setReasonCode(v as PaymentReversalReason)}
              className="space-y-2"
            >
              {REASON_OPTIONS.map((opt) => (
                <label
                  key={opt.code}
                  htmlFor={`reason-${opt.code}`}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-accent"
                >
                  <RadioGroupItem
                    id={`reason-${opt.code}`}
                    value={opt.code}
                    className="mt-1"
                  />
                  <div className="space-y-1">
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="text-xs text-muted-foreground">{opt.helper}</div>
                  </div>
                </label>
              ))}
            </RadioGroup>
          </div>
        )}

        {step === 2 && selected && (
          <div className="space-y-3">
            <Alert>
              <AlertDescription>
                <p className="text-sm font-medium">What will happen</p>
                <p className="text-xs text-muted-foreground mt-1">{selected.helper}</p>
              </AlertDescription>
            </Alert>

            <div className="rounded-lg border p-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Payment amount</span>
                <span className="font-medium">{formatCurrency(payment.amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Currently applied</span>
                <span className="font-medium">{formatCurrency(appliedAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Currently unapplied</span>
                <span className="font-medium">{formatCurrency(outstandingAmount)}</span>
              </div>
              <div className="my-2 border-t" />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Operation</span>
                <span className="font-mono uppercase">{selected.op}</span>
              </div>
            </div>

            {selected.op === "refund" && (
              <div className="space-y-3 rounded-lg border p-3">
                <div className="space-y-1">
                  <Label htmlFor="bank-account">Refund from bank account</Label>
                  <Select value={bankAccountId} onValueChange={setBankAccountId}>
                    <SelectTrigger id="bank-account">
                      <SelectValue placeholder="Choose a bank account" />
                    </SelectTrigger>
                    <SelectContent>
                      {bankAccounts.map((b) => (
                        <SelectItem key={b.id} value={b.account_id ?? b.id}>
                          {b.name} {b.bank_name ? `— ${b.bank_name}` : ""}
                          {b.currency ? ` (${b.currency})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {currencyMismatch && (
                    <p className="text-xs text-destructive">
                      Cross-currency refunds are not yet supported
                      ({selectedBank?.currency} ≠ {baseCurrency}). Choose a
                      bank account in {baseCurrency}.
                    </p>
                  )}
                </div>

                {appliedAmount > 0 && (
                  <label
                    htmlFor="allow-unapply-refund"
                    className="flex items-start gap-2 rounded-md border bg-muted/30 p-2 cursor-pointer"
                  >
                    <Checkbox
                      id="allow-unapply-refund"
                      checked={allowUnapplyForRefund}
                      onCheckedChange={(v) => setAllowUnapplyForRefund(v === true)}
                      className="mt-0.5"
                    />
                    <div className="space-y-0.5">
                      <div className="text-sm font-medium">
                        Also free cash from the linked invoice
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Without this, you can refund at most{" "}
                        {formatCurrency(outstandingAmount)} (the currently
                        unapplied portion). Tick to unapply from the invoice
                        first so up to {formatCurrency(appliedAmount + outstandingAmount)} can be refunded.
                      </div>
                    </div>
                  </label>
                )}

                <div className="space-y-1">
                  <Label htmlFor="refund-amount">
                    Refund amount (max {formatCurrency(refundCap)})
                  </Label>
                  <Input
                    id="refund-amount"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={refundCap}
                    step="0.01"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                    placeholder={String(refundCap.toFixed(2))}
                    disabled={refundCap <= 0}
                  />
                  {refundCap <= 0 && (
                    <p className="text-xs text-muted-foreground">
                      No cash available to refund. Tick the acknowledgement
                      above if you want to free cash from the invoice first.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && selected && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="reversal-date">Reversal date</Label>
              <Input
                id="reversal-date"
                type="date"
                value={reversalDate}
                onChange={(e) => setReversalDate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Must fall inside an open accounting period.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="reversal-note">
                Note <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="reversal-note"
                rows={3}
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                placeholder="Explain what happened for the audit trail."
              />
            </div>
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                This posts journal entries and updates the customer's balance.
                It cannot be undone from the UI — only counter-posted.
              </AlertDescription>
            </Alert>
          </div>
        )}

    </DetailSheet>
  );
}
