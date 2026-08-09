/**
 * ProcessRefundWizardPage — routed WizardShell replacement for the
 * legacy `ProcessRefundDialog`. Route:
 * `/finance/customer-credits/:id/refund`.
 *
 * Ports every behaviour from the retired dialog verbatim:
 *   - Refund amount defaults to `total - amountApplied - amountRefunded`
 *   - Method → cash / bank_transfer / check; picks the matching default
 *     payment account (via `useDefaultAccounts`)
 *   - Validates presence of default AR + payment account before enabling
 *     the submit; surfaces the same "configure defaults" error
 *   - Journal-entry preview mirrors the dialog's Dr AR / Cr Cash|Bank
 *   - On success redirects to `<returnTo>?peek=<id>` (default
 *     `/finance/customer-credits`) so the caller re-sees the record
 */
import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  DollarSign,
  Loader2,
} from "lucide-react";

import {
  ActionBar,
  ErrorState,
  FooterActionBar,
  LoadingState,
  RecordHeader,
  Section,
  WizardShell,
  WizardStepper,
  type WizardStep,
} from "@/design-system";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { useCreditNotes } from "@/hooks/useCreditNotes";
import { useCurrency } from "@/hooks/useCurrency";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

const STEPS: WizardStep[] = [
  { id: "amount", label: "Amount & method", description: "Refund details" },
  { id: "review", label: "Review", description: "Confirm the refund" },
];

export default function ProcessRefundWizardPage() {
  const navigate = useNavigate();
  const { id: creditNoteId = "" } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const returnTo = search.get("returnTo") || "/finance/customer-credits";

  const { creditNotes, processRefund, refreshCreditNotes } = useCreditNotes();
  const { formatCurrency } = useCurrency();
  const { accounts } = useDefaultAccounts();
  const { toast } = useToast();

  const creditNote = useMemo(
    () => creditNotes.find((c) => c.id === creditNoteId) || null,
    [creditNotes, creditNoteId],
  );

  const totalAmount = creditNote?.total || 0;
  const amountApplied = creditNote?.amount_applied || 0;
  const amountRefunded =
    (creditNote as { refund_amount?: number } | null)?.refund_amount || 0;
  const availableForRefund = totalAmount - amountApplied - amountRefunded;
  const contactName = creditNote?.contact?.name || "";
  const creditNoteNumber = creditNote?.credit_note_number || "";
  const currency = creditNote?.currency;

  const [step, setStep] = useState<"amount" | "review">("amount");
  const [refundAmount, setRefundAmount] = useState<number>(availableForRefund);
  const [refundMethod, setRefundMethod] = useState<string>("cash");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  /**
   * Phase 7 — one idempotency key per submission attempt. Retrying a failed
   * submit reuses the key so the refund engine dedupes instead of paying twice;
   * a genuinely new refund gets a new key.
   */
  const requestIdRef = useRef<string>(crypto.randomUUID());

  // Keep the default amount in sync until the user overrides it (once
  // they touch the field, we honour their number).
  const [amountTouched, setAmountTouched] = useState(false);
  if (!amountTouched && refundAmount === 0 && availableForRefund > 0) {
    setRefundAmount(availableForRefund);
  }

  const paymentAccountId = useMemo(() => {
    if (refundMethod === "cash") return accounts?.cash_account_id;
    if (refundMethod === "bank_transfer") return accounts?.bank_account_id;
    return accounts?.cash_account_id;
  }, [refundMethod, accounts]);
  const receivableAccountId = accounts?.accounts_receivable_id;
  const missingDefaults = !paymentAccountId || !receivableAccountId;

  const canSubmit =
    refundAmount > 0 &&
    refundAmount <= availableForRefund &&
    !!paymentAccountId &&
    !!receivableAccountId;

  const goBack = () => navigate(`${returnTo}?peek=${creditNoteId}`);

  const handleSubmit = async () => {
    if (!canSubmit || !creditNote) return;
    setIsSubmitting(true);
    try {
      await processRefund(
        creditNoteId,
        refundAmount,
        refundMethod,
        paymentAccountId!,
        notes || undefined,
        requestIdRef.current,
      );
      toast({
        title: `Refund of ${formatCurrency(refundAmount, currency)} processed for ${creditNoteNumber}`,
      });
      await refreshCreditNotes?.();
      requestIdRef.current = crypto.randomUUID();
      navigate(`${returnTo}?peek=${creditNoteId}`);
    } catch (err) {
      toast({
        title: "Refund failed",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!creditNote) {
    return creditNotes.length === 0 ? (
      <LoadingState />
    ) : (
      <ErrorState
        title="Credit note not found"
        description="This credit note may have been deleted or you don't have access."
      />
    );
  }

  const primary =
    step === "amount" ? (
      <Button onClick={() => setStep("review")} disabled={!canSubmit}>
        Review refund
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    ) : (
      <Button onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
        {isSubmitting ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <DollarSign className="mr-2 h-4 w-4" />
        )}
        Process refund
      </Button>
    );

  return (
    <WizardShell
      header={
        <RecordHeader
          eyebrow="Customer credits"
          title={`Refund credit · ${creditNoteNumber}`}
          meta={
            <span className="flex items-center gap-2">
              <span>To {contactName}</span>
              <Badge variant="outline">
                Available {formatCurrency(availableForRefund, currency)}
              </Badge>
            </span>
          }
        />
      }
      stepper={
        <WizardStepper
          steps={STEPS}
          activeStepId={step}
          completedStepIds={step === "review" ? ["amount"] : []}
          onStepClick={(id) => setStep(id as "amount" | "review")}
        />
      }
      footer={
        <FooterActionBar
          anchor="page"
          leading={
            step === "amount" ? (
              <Button variant="ghost" onClick={goBack} disabled={isSubmitting}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => setStep("amount")}
                disabled={isSubmitting}
              >
                Back
              </Button>
            )
          }
          trailing={<ActionBar>{primary}</ActionBar>}
        />
      }
    >
      {step === "amount" && (
        <>
          <Section title="Credit summary">
            <div className="grid grid-cols-1 gap-3 rounded-lg bg-muted/40 p-3 text-sm sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Credit total</p>
                <p className="font-semibold">
                  {formatCurrency(totalAmount, currency)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Applied</p>
                <p className="font-medium text-emerald-600">
                  {formatCurrency(amountApplied, currency)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  Available for refund
                </p>
                <p className="font-bold text-primary">
                  {formatCurrency(availableForRefund, currency)}
                </p>
              </div>
            </div>
          </Section>

          <Section title="Refund details">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Refund amount *</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={availableForRefund}
                  value={refundAmount}
                  onChange={(e) => {
                    setAmountTouched(true);
                    setRefundAmount(parseFloat(e.target.value) || 0);
                  }}
                />
                {refundAmount > availableForRefund && (
                  <p className="flex items-center gap-1 text-xs text-destructive">
                    <AlertCircle className="h-3 w-3" /> Cannot exceed the
                    available balance.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Refund method *</Label>
                <Select value={refundMethod} onValueChange={setRefundMethod}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                    <SelectItem value="check">Check</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Notes</Label>
                <Textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional refund notes…"
                />
              </div>
            </div>

            {missingDefaults && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Missing default account</AlertTitle>
                <AlertDescription>
                  Configure a default{" "}
                  {refundMethod === "bank_transfer" ? "bank" : "cash"} account
                  and Accounts Receivable in Settings → Default Accounts before
                  processing refunds.
                </AlertDescription>
              </Alert>
            )}
          </Section>
        </>
      )}

      {step === "review" && (
        <>
          <Section title="Confirm refund">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Credit note
                </dt>
                <dd className="mt-0.5 font-mono">{creditNoteNumber}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Customer
                </dt>
                <dd className="mt-0.5">{contactName}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Refund amount
                </dt>
                <dd className="mt-0.5 text-base font-semibold text-primary">
                  {formatCurrency(refundAmount, currency)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Refund method
                </dt>
                <dd className="mt-0.5 capitalize">
                  {refundMethod.replace("_", " ")}
                </dd>
              </div>
              {notes && (
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium text-muted-foreground">
                    Notes
                  </dt>
                  <dd className="mt-0.5 whitespace-pre-wrap">{notes}</dd>
                </div>
              )}
            </dl>
          </Section>

          <Section title="Journal entry preview">
            <div className="space-y-1 rounded-lg bg-muted/30 p-3 font-mono text-xs">
              <div className="flex justify-between">
                <span className="flex items-center gap-2">
                  <ArrowUp className="h-3 w-3 text-red-500" />
                  Dr: Accounts Receivable
                </span>
                <span>{formatCurrency(refundAmount, currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="flex items-center gap-2">
                  <ArrowDown className="h-3 w-3 text-green-500" />
                  Cr:{" "}
                  {refundMethod === "bank_transfer" ? "Bank Account" : "Cash"}
                </span>
                <span>{formatCurrency(refundAmount, currency)}</span>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              This reverses the AR credit and records the cash outflow.
            </p>
          </Section>
        </>
      )}
    </WizardShell>
  );
}
