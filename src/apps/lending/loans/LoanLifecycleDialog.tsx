/**
 * Loan lifecycle exceptions (C8) — write-off, closure, top-up and restructure.
 *
 * All four are guarded server-side business events. Write-off derives its
 * amounts from the loan's own outstanding balances and posts the configured
 * accounting treatment; closure is refused while anything remains due; a
 * top-up or restructure mints a successor loan that carries forward the
 * outstanding principal and settles the predecessor on disbursement. React
 * only collects intent — no amount, interest or balance maths happens here.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { MfLoan, MfLoanLineageKind } from "@/hooks/useMfLoans";

export type LoanLifecycleAction =
  | "write_off"
  | "close"
  | "top_up"
  | "restructure"
  | "reverse_disbursement"
  | "cancel";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loan: MfLoan | null;
  action: LoanLifecycleAction;
  onWriteOff: (input: { loanId: string; writtenOffOn: string; reason: string }) => Promise<void>;
  onClose: (input: { loanId: string; closedOn: string; notes: string | null }) => Promise<void>;
  onReissue: (input: {
    loanId: string;
    kind: Exclude<MfLoanLineageKind, "new">;
    additionalPrincipal: number | null;
    termInstallments: number | null;
    interestRate: number | null;
    expectedDisbursementDate: string | null;
    firstInstallmentDate: string | null;
    reason: string;
  }) => Promise<void>;
  onReverseDisbursement: (input: { loanId: string; reason: string }) => Promise<void>;
  onCancelLoan?: (input: { loanId: string; reason: string }) => Promise<void>;
}

const TITLES: Record<LoanLifecycleAction, string> = {
  write_off: "Write off loan",
  close: "Close loan",
  top_up: "Top up loan",
  restructure: "Restructure loan",
  reverse_disbursement: "Reverse disbursement",
  cancel: "Cancel loan",
};

const DESCRIPTIONS: Record<LoanLifecycleAction, string> = {
  write_off:
    "The outstanding principal and interest are taken from the loan's own balances and posted to the configured write-off accounts. This cannot be undone.",
  close:
    "Closure is only accepted once the loan is fully settled. The loan and its history remain on record.",
  top_up:
    "A successor loan is created carrying forward this loan's outstanding principal plus the additional amount. Nothing is edited on this loan — it is settled when the successor is disbursed.",
  restructure:
    "A successor loan is created on revised terms carrying forward this loan's outstanding principal. No additional principal may be added, and this loan's history is preserved.",
  reverse_disbursement:
    "Use this only when the disbursement itself was made in error. The server reverses the original ledger entry, returns the loan to pending disbursement and restores the contractual schedule. It is refused once any receipt has been recorded.",
  cancel:
    "Use this when the loan should never have been created — a wrong amount, term or client. The loan is marked cancelled and its application is closed as cancelled; nothing is deleted. It is refused if money has moved. Book a fresh application with the correct details.",
};

export function LoanLifecycleDialog({
  open,
  onOpenChange,
  loan,
  action,
  onWriteOff,
  onClose,
  onReissue,
  onReverseDisbursement,
  onCancelLoan,
}: Props) {
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [additional, setAdditional] = useState("");
  const [term, setTerm] = useState("");
  const [rate, setRate] = useState("");
  const [firstDue, setFirstDue] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDate(new Date().toISOString().slice(0, 10));
    setReason("");
    setAdditional("");
    setTerm(loan ? String(loan.term_installments) : "");
    setRate(loan ? String(loan.interest_rate) : "");
    setFirstDue("");
  }, [open, loan, action]);

  const isWriteOff = action === "write_off";
  const isClose = action === "close";
  const isReissue = action === "top_up" || action === "restructure";
  const isReversal = action === "reverse_disbursement";
  const reasonRequired = !isClose;

  const canSubmit =
    !!loan &&
    (isReversal || !!date) &&
    (!reasonRequired || reason.trim().length > 0) &&
    (!isReissue || !!term);

  const submit = async () => {
    if (!loan || !canSubmit) return;
    setSaving(true);
    try {
      if (isReversal) {
        await onReverseDisbursement({ loanId: loan.id, reason: reason.trim() });
      } else if (isWriteOff) {
        await onWriteOff({ loanId: loan.id, writtenOffOn: date, reason: reason.trim() });
      } else if (isClose) {
        await onClose({ loanId: loan.id, closedOn: date, notes: reason.trim() || null });
      } else {
        await onReissue({
          loanId: loan.id,
          kind: action === "top_up" ? "topup" : "restructure",
          additionalPrincipal: action === "top_up" ? Number(additional || 0) : null,
          termInstallments: term ? Number(term) : null,
          interestRate: rate ? Number(rate) : null,
          expectedDisbursementDate: date,
          firstInstallmentDate: firstDue || null,
          reason: reason.trim(),
        });
      }
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {TITLES[action]} {loan?.loan_number ?? ""}
          </DialogTitle>
          <DialogDescription>{DESCRIPTIONS[action]}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!isReversal && (
          <div className="space-y-1.5">
            <Label htmlFor="lifecycle-date">
              {isWriteOff
                ? "Write-off date"
                : isClose
                  ? "Closure date"
                  : "Expected disbursement date"}
            </Label>
            <Input
              id="lifecycle-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          )}

          {isReissue && (
            <>
              {action === "top_up" && (
                <div className="space-y-1.5">
                  <Label htmlFor="lifecycle-additional">
                    Additional principal ({loan?.currency_code ?? ""})
                  </Label>
                  <Input
                    id="lifecycle-additional"
                    type="number"
                    min="0"
                    step="0.01"
                    value={additional}
                    onChange={(e) => setAdditional(e.target.value)}
                    placeholder="0.00"
                  />
                  <p className="text-xs text-muted-foreground">
                    The outstanding principal is carried forward by the server and added to this
                    amount.
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="lifecycle-term">Term (installments)</Label>
                  <Input
                    id="lifecycle-term"
                    type="number"
                    min="1"
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lifecycle-rate">Interest rate</Label>
                  <Input
                    id="lifecycle-rate"
                    type="number"
                    min="0"
                    step="0.01"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lifecycle-first-due">First installment date (optional)</Label>
                <Input
                  id="lifecycle-first-due"
                  type="date"
                  value={firstDue}
                  onChange={(e) => setFirstDue(e.target.value)}
                />
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="lifecycle-reason">
              {reasonRequired ? "Reason (required)" : "Notes (optional)"}
            </Label>
            <Textarea
              id="lifecycle-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                isReversal
                  ? "Why is this disbursement being reversed?"
                  : isWriteOff
                  ? "Why is this loan being written off?"
                  : isClose
                    ? "Anything worth recording about this closure"
                    : action === "top_up"
                      ? "Why is this client being topped up?"
                      : "Why is this loan being restructured?"
              }
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant={isWriteOff || isReversal ? "destructive" : "default"}
            onClick={submit}
            disabled={!canSubmit || saving}
          >
            {saving ? "Working…" : TITLES[action]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default LoanLifecycleDialog;
