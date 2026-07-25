/**
 * RequestLoanWizard — employee-facing loan/advance request.
 *
 * Slimmer than the admin LoanWizard: the employee picks a configured
 * `loan_type`, enters amount + installments + start date + reason within
 * the loan type's policy bounds, and submits. The request lands in
 * `employee_loans.status = 'requested'` and HR/Payroll approves it.
 *
 * The wizard:
 *  - shows the active **repayment method** as a read-only badge
 *  - enforces `min/max_installments` and `min/max_principal` from the loan
 *    type, with inline error copy
 *  - shows a live **estimated monthly deduction** so the employee can see
 *    what they're committing to before submitting
 *  - surfaces loan-type policy (caps, floors) as helper text
 *
 * Server-side, `enforce_loan_request_policy_bounds_trg` re-validates the
 * same bounds — the wizard cannot be bypassed by a scripted client.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  WorkflowSheet,
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";
import { useLoanTypes, type RepaymentMethod, type LoanType } from "@/hooks/useLoanTypes";
import { useMyLoans } from "@/hooks/useMyLoans";
import { useCurrency } from "@/hooks/useCurrency";

interface Props {
  open: boolean;
  onClose: () => void;
}

const METHOD_LABEL: Record<RepaymentMethod, string> = {
  fixed_installment: "Fixed installment",
  fixed_amount: "Fixed monthly amount",
  percent_of_net: "% of net pay",
  one_off_next_payroll: "One-off · next payroll",
};

function describePolicy(t: LoanType, fmt: (n: number) => string): string[] {
  const out: string[] = [];
  if (t.min_principal != null || t.max_principal != null) {
    const lo = t.min_principal != null ? fmt(Number(t.min_principal)) : "any";
    const hi = t.max_principal != null ? fmt(Number(t.max_principal)) : "any";
    out.push(`Amount ${lo} – ${hi}`);
  }
  if (
    t.default_repayment_method !== "one_off_next_payroll" &&
    (t.min_installments != null || t.max_installments != null)
  ) {
    const lo = t.min_installments ?? 1;
    const hi = t.max_installments ?? "—";
    out.push(`${lo} – ${hi} installments`);
  }
  if (t.default_max_pct_of_net != null) {
    out.push(`Max ${t.default_max_pct_of_net}% of net pay`);
  }
  if (t.default_min_net_pay_floor != null) {
    out.push(`Net floor ${fmt(Number(t.default_min_net_pay_floor))}`);
  }
  return out;
}

export function RequestLoanWizard({ open, onClose }: Props) {
  const { activeLoanTypes } = useLoanTypes();
  const { requestLoan } = useMyLoans();
  const { formatCurrency } = useCurrency();

  const [loanTypeId, setLoanTypeId] = useState("");
  const [amount, setAmount] = useState("");
  const [installments, setInstallments] = useState("");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [repaymentMethod, setRepaymentMethod] = useState<RepaymentMethod>("fixed_installment");
  const [consent, setConsent] = useState(false);
  const [collateral, setCollateral] = useState("");

  // Stable per-wizard-session idempotency key — protects against
  // double-tap/offline-retry duplicates.
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID());

  const loanType = useMemo(
    () => activeLoanTypes.find((t) => t.id === loanTypeId) ?? null,
    [activeLoanTypes, loanTypeId],
  );

  const needsConsent = !!loanType?.requires_consent;
  const needsCollateral = !!loanType?.requires_collateral;

  useEffect(() => {
    if (!loanType) return;
    setRepaymentMethod(loanType.default_repayment_method);
    // Consent is per-request authorisation — never carry it across types.
    setConsent(false);
    setCollateral("");
    if (loanType.default_installments && !installments) {
      setInstallments(String(loanType.default_installments));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loanType?.id]);

  const reset = () => {
    setLoanTypeId("");
    setAmount("");
    setInstallments("");
    setReason("");
    setConsent(false);
    setCollateral("");
    setStartDate(new Date().toISOString().slice(0, 10));
    idempotencyKeyRef.current = crypto.randomUUID();
  };


  const handleClose = () => {
    if (requestLoan.isPending) return;
    reset();
    onClose();
  };

  const principalNum = Number(amount);
  const installmentsNum = Number(installments);
  const isOneOff = repaymentMethod === "one_off_next_payroll";

  // Bounds validation (mirrors the server-side trigger)
  const errors: string[] = [];
  if (loanType && principalNum > 0) {
    if (loanType.min_principal != null && principalNum < Number(loanType.min_principal)) {
      errors.push(`Minimum amount is ${formatCurrency(Number(loanType.min_principal))}`);
    }
    if (loanType.max_principal != null && principalNum > Number(loanType.max_principal)) {
      errors.push(`Maximum amount is ${formatCurrency(Number(loanType.max_principal))}`);
    }
  }
  if (loanType && !isOneOff && installmentsNum > 0) {
    if (loanType.min_installments != null && installmentsNum < loanType.min_installments) {
      errors.push(`At least ${loanType.min_installments} installment(s) required`);
    }
    if (loanType.max_installments != null && installmentsNum > loanType.max_installments) {
      errors.push(`No more than ${loanType.max_installments} installment(s) allowed`);
    }
  }

  const canSubmit =
    !!loanTypeId &&
    !!amount &&
    principalNum > 0 &&
    !!startDate &&
    (isOneOff || installmentsNum > 0) &&
    (!needsConsent || consent) &&
    (!needsCollateral || collateral.trim().length > 0) &&
    errors.length === 0;


  // Live estimated monthly deduction — same formula the hook will persist.
  const estimatedMonthly =
    principalNum > 0
      ? isOneOff
        ? principalNum
        : installmentsNum > 0
          ? Math.round((principalNum / installmentsNum) * 100) / 100
          : null
      : null;

  const policyChips = loanType ? describePolicy(loanType, formatCurrency) : [];

  const handleSubmit = async () => {
    if (!canSubmit) return;
    try {
      await requestLoan.mutateAsync({
        input: {
          loan_type_id: loanTypeId,
          principal_amount: principalNum,
          total_installments: isOneOff ? 1 : installmentsNum,
          start_date: startDate,
          repayment_method: repaymentMethod,
          reason: reason || null,
        },
        options: { idempotencyKey: idempotencyKeyRef.current },
      });
      handleClose();
    } catch {
      // toast already shown in hook
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={(v) => (!v ? handleClose() : null)}
      size="xl"
      title="Request a loan or advance"
      description="Submit the details below. Your request will be sent to HR / payroll for approval before any money is disbursed."
      footer={
        <>
          <Button variant="outline" onClick={handleClose} disabled={requestLoan.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || requestLoan.isPending}>
            {requestLoan.isPending ? "Submitting…" : "Submit request"}
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Loan type" subtitle="Choose the program — policy bounds load from the type.">
        <WorkflowField label="Loan type" required>
          <Select value={loanTypeId} onValueChange={setLoanTypeId}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a loan type" />
            </SelectTrigger>
            <SelectContent>
              {activeLoanTypes.length === 0 ? (
                <div className="p-2 text-sm text-muted-foreground">
                  No loan types configured. Contact HR.
                </div>
              ) : (
                activeLoanTypes.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </WorkflowField>
        {loanType && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="font-normal">
              Repayment: {METHOD_LABEL[repaymentMethod]}
            </Badge>
            {policyChips.map((chip) => (
              <Badge key={chip} variant="outline" className="font-normal">
                {chip}
              </Badge>
            ))}
          </div>
        )}
        {loanType?.description && (
          <p className="text-xs text-muted-foreground">{loanType.description}</p>
        )}
      </WorkflowSheetSection>

      <WorkflowSheetGrid>
        <WorkflowSheetSection number={2} title="Amount & schedule">
          <div className="grid grid-cols-2 gap-3">
            <WorkflowField label="Amount" required>
              <Input
                type="number"
                min={loanType?.min_principal ?? 0}
                max={loanType?.max_principal ?? undefined}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </WorkflowField>
            <WorkflowField label="Start date" required>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </WorkflowField>
          </div>
          {!isOneOff && (
            <WorkflowField
              label="Repayment installments (months)"
              required
              hint="HR can adjust the schedule before approval."
            >
              <Input
                type="number"
                min={loanType?.min_installments ?? 1}
                max={loanType?.max_installments ?? undefined}
                value={installments}
                onChange={(e) => setInstallments(e.target.value)}
                placeholder="e.g. 6"
              />
            </WorkflowField>
          )}
          {isOneOff && (
            <Card className="bg-muted/30 border-dashed">
              <CardContent className="py-3 text-xs text-muted-foreground">
                This is a salary advance — the full amount will be recovered
                from your next payroll run.
              </CardContent>
            </Card>
          )}
        </WorkflowSheetSection>

        <WorkflowSheetSection number={3} title="Estimate & justification">
          {estimatedMonthly !== null && errors.length === 0 && (
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {isOneOff ? "One-off deduction" : "Estimated monthly deduction"}
                  </span>
                  <span className="font-semibold tabular-nums">
                    {formatCurrency(estimatedMonthly)}
                  </span>
                </div>
                {!isOneOff && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Indicative — HR may adjust the schedule before approval.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
          {errors.length > 0 && (
            <Card className="border-destructive/40 bg-destructive/5">
              <CardContent className="py-3 text-xs text-destructive space-y-1">
                {errors.map((err) => (
                  <div key={err}>• {err}</div>
                ))}
              </CardContent>
            </Card>
          )}
          <WorkflowField label="Reason (optional)">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you requesting this?"
              rows={4}
            />
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheetGrid>
    </WorkflowSheet>
  );
}
