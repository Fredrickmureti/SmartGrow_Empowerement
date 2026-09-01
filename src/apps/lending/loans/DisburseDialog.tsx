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
import { MF_DISBURSEMENT_METHODS, type MfLoan } from "@/hooks/useMfLoans";

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
