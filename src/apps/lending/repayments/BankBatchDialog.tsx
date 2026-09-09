/**
 * Bank a closed collection batch (C14). Intent only — the server totals the
 * receipts, posts the journal and creates the reconcilable bank deposit line.
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
import {
  BranchDayDateField,
  useBranchDayGate,
} from "@/components/lending/BranchDayDateField";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MfBankableAccount } from "@/hooks/useMfCollectionBankings";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batchLabel: string;
  bankAccounts: MfBankableAccount[];
  defaultDate: string;
  onBank: (input: {
    bankAccountId: string;
    bankedOn: string;
    reference: string | null;
    notes: string | null;
  }) => Promise<unknown>;
}

export function BankBatchDialog({
  open,
  onOpenChange,
  batchLabel,
  bankAccounts,
  defaultDate,
  onBank,
}: Props) {
  const [bankAccountId, setBankAccountId] = useState("");
  const [bankedOn, setBankedOn] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBankAccountId(bankAccounts[0]?.id ?? "");
    setBankedOn(defaultDate);
    setReference("");
    setNotes("");
    setSaving(false);
  }, [open, defaultDate, bankAccounts]);

  const submit = async () => {
    if (!bankAccountId || !bankedOn) return;
    setSaving(true);
    try {
      await onBank({
        bankAccountId,
        bankedOn,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bank collections</DialogTitle>
          <DialogDescription>
            Deposit the cash and mobile-money receipts of {batchLabel} into a bank
            account. The deposit total is taken from the posted receipts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Bank account</Label>
            <Select value={bankAccountId} onValueChange={setBankAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Select bank account" />
              </SelectTrigger>
              <SelectContent>
                {bankAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                    {a.bank_name ? ` · ${a.bank_name}` : ""}
                    {a.account_number ? ` · ${a.account_number}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {bankAccounts.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No active bank account yet. Create one under Finance → Banking.
              </p>
            )}
          </div>

          <BranchDayDateField
            id="banked-on"
            label="Banked on"
            value={bankedOn}
            onChange={setBankedOn}
          />
          <div className="hidden">
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deposit-ref">Deposit slip / reference</Label>
            <Input
              id="deposit-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="banking-notes">Notes</Label>
            <Textarea
              id="banking-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || !bankAccountId || !bankedOn || dayGate.blocked}
          >
            {saving ? "Banking…" : "Bank collections"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
