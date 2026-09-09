/**
 * Payment capture (C7). The dialog collects intent only — the server allocates
 * the money across installments following the configured allocation order.
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
import { MF_REPAYMENT_METHODS, type MfLoanBalance } from "@/hooks/useMfRepayments";
import {
  BranchDayDateField,
  useBranchDayGate,
} from "@/components/lending/BranchDayDateField";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loans: MfLoanBalance[];
  batchId: string | null;
  onRecord: (input: {
    loanId: string;
    paidOn: string;
    amount: number;
    method: string;
    reference: string | null;
    batchId: string | null;
    notes: string | null;
  }) => Promise<unknown>;
}

export function RecordPaymentDialog({ open, onOpenChange, loans, batchId, onRecord }: Props) {
  const [loanId, setLoanId] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const dayGate = useBranchDayGate();

  useEffect(() => {
    if (!open) return;
    setLoanId("");
    setPaidOn(new Date().toISOString().slice(0, 10));
    setAmount("");
    setMethod("cash");
    setReference("");
    setNotes("");
  }, [open]);

  const selected = loans.find((l) => l.loan_id === loanId) ?? null;

  const submit = async () => {
    if (!loanId || !amount) return;
    setSaving(true);
    try {
      await onRecord({
        loanId,
        paidOn,
        amount: Number(amount),
        method,
        reference: reference.trim() || null,
        batchId,
        notes: notes.trim() || null,
      });
      onOpenChange(false);
    } catch {
      // The refusal is already shown to the user by the mutation's error
      // handler; swallow it here so nothing lands unhandled in the console
      // and the dialog stays open with the captured values.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
          <DialogDescription>
            Allocation is decided by the server using the institution's configured order.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Loan</Label>
            <Select value={loanId} onValueChange={setLoanId}>
              <SelectTrigger>
                <SelectValue placeholder="Select an active loan" />
              </SelectTrigger>
              <SelectContent>
                {loans.map((l) => (
                  <SelectItem key={l.loan_id} value={l.loan_id}>
                    {l.loan_number} — outstanding {l.currency_code}{" "}
                    {Number(l.total_outstanding).toLocaleString()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && (
              <p className="text-xs text-muted-foreground">
                Overdue {selected.currency_code}{" "}
                {Number(selected.amount_overdue).toLocaleString()} · DPD{" "}
                {selected.days_past_due} · next due {selected.next_due_date ?? "—"}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <BranchDayDateField
              label="Paid on"
              value={paidOn}
              onChange={setPaidOn}
              className="grid gap-1.5"
            />
            <div className="grid gap-1.5">
              <Label>Amount</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MF_REPAYMENT_METHODS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Reference</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Notes</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !loanId || !amount || dayGate.blocked}>
            {saving ? "Recording…" : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
