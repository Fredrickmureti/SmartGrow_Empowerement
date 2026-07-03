/**
 * ApplyCreditWizardPage — routed WizardShell replacement for the legacy
 * `ApplyCreditDialog`. Route: `/finance/customer-credits/:id/apply`.
 *
 * Ports every behaviour from the retired dialog verbatim:
 *  - Branch-scoped open-invoice list for the credit note's contact
 *  - Max-applicable = min(availableCredit, invoiceBalance)
 *  - Applies via `useCreditNotes().applyCreditToInvoice(...)` with the
 *    current `useFinanceScope().branchId`
 *  - Redirects back to the caller (default `/finance/customer-credits?peek=<id>`)
 *    via `?returnTo=<path>` so the caller re-sees the updated credit note
 */
import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, FileText, Loader2 } from "lucide-react";

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
import { useInvoices } from "@/hooks/useInvoices";
import { useCreditNotes } from "@/hooks/useCreditNotes";
import { useCurrency } from "@/hooks/useCurrency";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

const STEPS: WizardStep[] = [
  { id: "invoice", label: "Select invoice", description: "Choose an open invoice" },
  { id: "review", label: "Review & apply", description: "Confirm the allocation" },
];

export default function ApplyCreditWizardPage() {
  const navigate = useNavigate();
  const { id: creditNoteId = "" } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const returnTo = search.get("returnTo") || "/finance/customer-credits";

  const { creditNotes, applyCreditToInvoice, refreshCreditNotes } = useCreditNotes();
  const { invoices } = useInvoices();
  const { formatCurrency } = useCurrency();
  const { branchId } = useFinanceScope();
  const { toast } = useToast();

  const creditNote = useMemo(
    () => creditNotes.find((c) => c.id === creditNoteId) || null,
    [creditNotes, creditNoteId],
  );

  const availableAmount = creditNote
    ? (creditNote.total || 0) - (creditNote.amount_applied || 0)
    : 0;
  const contactId = creditNote?.contact_id || "";
  const contactName = creditNote?.contact?.name || "";
  const creditNoteNumber = creditNote?.credit_note_number || "";

  const openInvoices = useMemo(
    () =>
      invoices.filter((inv) => {
        if (inv.contact_id !== contactId) return false;
        if (
          inv.status === "paid" ||
          inv.status === "cancelled" ||
          inv.status === "draft"
        )
          return false;
        if ((inv.total || 0) - (inv.amount_paid || 0) <= 0) return false;
        const invBranchId = (inv as { branch_id?: string | null }).branch_id;
        if (branchId && invBranchId && invBranchId !== branchId) return false;
        return true;
      }),
    [invoices, contactId, branchId],
  );

  const [step, setStep] = useState<"invoice" | "review">("invoice");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [isApplying, setIsApplying] = useState(false);

  const selectedInvoice = openInvoices.find((i) => i.id === selectedInvoiceId);
  const invoiceBalance = selectedInvoice
    ? (selectedInvoice.total || 0) - (selectedInvoice.amount_paid || 0)
    : 0;
  const maxApplicable = Math.min(availableAmount, invoiceBalance);
  const parsedAmount = parseFloat(amount) || 0;
  const overMax = parsedAmount > maxApplicable;
  const canProceed = !!selectedInvoiceId && parsedAmount > 0 && !overMax;

  const goBack = () => navigate(`${returnTo}?peek=${creditNoteId}`);

  const handleApply = async () => {
    if (!creditNote || !canProceed) return;
    setIsApplying(true);
    try {
      await applyCreditToInvoice(
        creditNoteId,
        selectedInvoiceId,
        parsedAmount,
        notes || undefined,
        branchId,
      );
      toast({ title: "Credit applied successfully" });
      await refreshCreditNotes?.();
      navigate(`${returnTo}?peek=${creditNoteId}`);
    } catch (err) {
      toast({
        title: "Failed to apply credit",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setIsApplying(false);
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
    step === "invoice" ? (
      <Button onClick={() => setStep("review")} disabled={!canProceed}>
        Continue
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    ) : (
      <Button onClick={handleApply} disabled={!canProceed || isApplying}>
        {isApplying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Apply {formatCurrency(parsedAmount)}
      </Button>
    );

  return (
    <WizardShell
      header={
        <RecordHeader
          eyebrow="Customer credits"
          title={`Apply credit · ${creditNoteNumber}`}
          meta={
            <span className="flex items-center gap-2">
              <span>To an open invoice for {contactName}</span>
              <Badge variant="outline">
                Available {formatCurrency(availableAmount)}
              </Badge>
            </span>
          }
        />
      }
      stepper={
        <WizardStepper
          steps={STEPS}
          activeStepId={step}
          completedStepIds={step === "review" ? ["invoice"] : []}
          onStepClick={(id) => setStep(id as "invoice" | "review")}
        />
      }
      footer={
        <FooterActionBar
          anchor="page"
          leading={
            step === "invoice" ? (
              <Button variant="ghost" onClick={goBack} disabled={isApplying}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => setStep("invoice")}
                disabled={isApplying}
              >
                Back
              </Button>
            )
          }
          trailing={<ActionBar>{primary}</ActionBar>}
        />
      }
    >
      {step === "invoice" && (
        <Section
          title="Invoice & amount"
          description="Pick the invoice to apply this credit against."
        >
          {openInvoices.length === 0 ? (
            <Alert>
              <FileText className="h-4 w-4" />
              <AlertTitle>No open invoices</AlertTitle>
              <AlertDescription>
                {contactName} has no outstanding invoices in this branch to
                apply credit to.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2">
                <Label>Invoice</Label>
                <Select
                  value={selectedInvoiceId}
                  onValueChange={(v) => {
                    setSelectedInvoiceId(v);
                    setAmount("");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select an invoice…" />
                  </SelectTrigger>
                  <SelectContent>
                    {openInvoices.map((inv) => (
                      <SelectItem key={inv.id} value={inv.id}>
                        <span className="mr-2 font-mono text-xs">
                          {inv.invoice_number}
                        </span>
                        <span className="text-muted-foreground">
                          Balance{" "}
                          {formatCurrency(
                            (inv.total || 0) - (inv.amount_paid || 0),
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedInvoiceId && (
                <>
                  <div className="space-y-2">
                    <Label>Amount to apply</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={maxApplicable}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder={`Max ${maxApplicable.toFixed(2)}`}
                    />
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => setAmount(maxApplicable.toFixed(2))}
                    >
                      Apply maximum ({formatCurrency(maxApplicable)})
                    </Button>
                    {overMax && (
                      <p className="text-xs text-destructive">
                        Cannot exceed the maximum applicable amount.
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>Notes (optional)</Label>
                    <Textarea
                      rows={2}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Application notes…"
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </Section>
      )}

      {step === "review" && (
        <Section title="Confirm application">
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
                Invoice
              </dt>
              <dd className="mt-0.5 font-mono">
                {selectedInvoice?.invoice_number}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Invoice balance
              </dt>
              <dd className="mt-0.5">{formatCurrency(invoiceBalance)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Available credit
              </dt>
              <dd className="mt-0.5">{formatCurrency(availableAmount)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">
                Amount to apply
              </dt>
              <dd className="mt-0.5 text-base font-semibold text-primary">
                {formatCurrency(parsedAmount)}
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
      )}
    </WizardShell>
  );
}
