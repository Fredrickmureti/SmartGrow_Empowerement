/**
 * Disbursement (C6) — a guarded business event, not a field update.
 *
 * The server enforces approval state, single-shot idempotency and amount
 * integrity against the approved principal, then realigns the contractual
 * schedule to the actual value date.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MF_DISBURSEMENT_METHODS,
  useMfLoanFeePreview,
  type MfLoan,
} from "@/hooks/useMfLoans";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loan: MfLoan | null;
  onDisburse: (input: {
    loanId: string;
    disbursedOn: string;
    amount: number;
    method: string;
    reference: string | null;
    receivedByName: string | null;
    notes: string | null;
  }) => Promise<void>;
}

export function DisburseDialog({ open, onOpenChange, loan, onDisburse }: Props) {
  const [date, setDate] = useState("");
  const [method, setMethod] = useState<string>("cash");
  const [reference, setReference] = useState("");
  const [receivedBy, setReceivedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  // Fees are resolved server-side; this dialog only displays them.
  const { fees, deductedTotal, isLoading: feesLoading } = useMfLoanFeePreview(
    open ? (loan?.id ?? null) : null,
  );
  const principal = Number(loan?.principal ?? 0);
  const netPayable = principal - deductedTotal;
  const money = (n: number) =>
    `${loan?.currency_code ?? ""} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  useEffect(() => {
    if (!open || !loan) return;
    setDate(loan.expected_disbursement_date ?? new Date().toISOString().slice(0, 10));
    setMethod("cash");
    setReference("");
    setReceivedBy("");
    setNotes("");
  }, [open, loan]);

  const submit = async () => {
    if (!loan) return;
    setSaving(true);
    try {
      await onDisburse({
        loanId: loan.id,
        disbursedOn: date,
        amount: Number(loan.principal),
        method,
        reference: reference.trim() || null,
        receivedByName: receivedBy.trim() || null,
        notes: notes.trim() || null,
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Disburse {loan?.loan_number}</DialogTitle>
          <DialogDescription>
            {loan
              ? `${loan.currency_code} ${Number(loan.principal).toLocaleString()} — the full approved principal. A loan can only be disbursed once.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {loan ? (
            <div className="space-y-1.5 rounded-md border bg-muted/40 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Gross principal</span>
                <span className="font-medium">{money(principal)}</span>
              </div>
              {feesLoading ? (
                <p className="text-xs text-muted-foreground">Resolving fees…</p>
              ) : (
                fees.map((fee, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-muted-foreground">
                      {fee.name}
                      {fee.basis === "percent_of_principal" ? ` (${fee.value}%)` : ""}
                      {fee.collection === "added_to_first_installment"
                        ? " — added to first installment"
                        : ""}
                    </span>
                    <span>
                      {fee.collection === "deducted_from_disbursement" ? "−" : ""}
                      {money(fee.amount)}
                    </span>
                  </div>
                ))
              )}
              <div className="flex items-center justify-between border-t pt-1.5 font-semibold">
                <span>Net cash payable</span>
                <span>{money(netPayable)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                The client's obligation remains the full principal of {money(principal)}.
              </p>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="disbDate">Value date</Label>
              <Input
                id="disbDate"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MF_DISBURSEMENT_METHODS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ref">Reference</Label>
              <Input
                id="ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Transaction / voucher no."
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recv">Received by</Label>
              <Input
                id="recv"
                value={receivedBy}
                onChange={(e) => setReceivedBy(e.target.value)}
                placeholder="Name of the recipient"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="dnotes">Notes</Label>
            <Textarea
              id="dnotes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !date}>
            {saving ? "Disbursing…" : "Confirm disbursement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
