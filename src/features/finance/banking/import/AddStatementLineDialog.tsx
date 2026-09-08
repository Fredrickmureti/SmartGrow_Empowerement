/**
 * Manual entry of a single bank statement line.
 *
 * Branches whose bank still delivers a paper or PDF statement have no file to
 * upload, yet the reconciliation proof must still hold. Rather than adding a
 * second ingestion path, this dialog hands ONE row to the same server engine
 * the file import uses (`bank_statement_import_batch`, source `manual`), so a
 * typed line gets the identical duplicate fingerprint, categorisation rules,
 * account-lifecycle check, closed-period refusal and business event.
 *
 * It records what the BANK reported. It posts nothing: a statement line only
 * becomes an accounting fact when it is matched or categorised.
 */

import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";

interface BankAccountOption {
  id: string;
  account_name?: string | null;
  name?: string | null;
  bank_name?: string | null;
}

interface AddStatementLineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: BankAccountOption[] | undefined;
  defaultAccountId?: string;
  onAdded?: () => void;
}

const accountLabel = (a: BankAccountOption) =>
  [a.account_name ?? a.name ?? "Bank account", a.bank_name].filter(Boolean).join(" · ");

export function AddStatementLineDialog({
  open,
  onOpenChange,
  accounts,
  defaultAccountId,
  onAdded,
}: AddStatementLineDialogProps) {
  const [accountId, setAccountId] = useState(defaultAccountId ?? "");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [direction, setDirection] = useState<"credit" | "debit">("credit");
  const [amount, setAmount] = useState("");
  const [balanceAfter, setBalanceAfter] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setDescription("");
    setReference("");
    setAmount("");
    setBalanceAfter("");
  };

  const handleSubmit = async () => {
    const value = Number(amount);
    if (!accountId) return toast.error("Choose the bank account this line came from.");
    if (!description.trim()) return toast.error("Enter the description shown on the statement.");
    if (!Number.isFinite(value) || value <= 0) return toast.error("Enter the amount on the statement.");

    setSaving(true);
    try {
      const { data, error } = await supabase.rpc("bank_statement_import_batch", {
        _bank_account_id: accountId,
        _rows: [
          {
            transaction_date: date,
            description: description.trim(),
            reference: reference.trim() || null,
            amount: direction === "credit" ? value : -value,
            balance_after: balanceAfter === "" ? null : Number(balanceAfter),
            raw_data: null,
          },
        ],
        _statement: null,
        _source: "manual",
      } as never);

      if (error) throw error;

      const result = (data ?? {}) as {
        inserted?: number;
        duplicates?: number;
        rejected?: number;
        rejected_rows?: Array<{ row: number; reason: string }>;
      };

      if (result.rejected) {
        toast.error(result.rejected_rows?.[0]?.reason ?? "The statement line was rejected.");
        return;
      }
      if (result.duplicates) {
        toast.warning("This line is already on the statement for that account — nothing was added.");
        return;
      }

      toast.success("Statement line added. It is now waiting to be matched.");
      reset();
      onAdded?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The statement line could not be added.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a statement line</DialogTitle>
          <DialogDescription>
            Type one line exactly as your bank reports it. Nothing is posted to the
            accounts until the line is matched or categorised.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>Bank account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Select bank account" />
              </SelectTrigger>
              <SelectContent>
                {accounts?.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="stmt-date">Date on statement</Label>
              <Input id="stmt-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Money</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as "credit" | "debit")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="credit">Into the account</SelectItem>
                  <SelectItem value="debit">Out of the account</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="stmt-desc">Description</Label>
            <Input
              id="stmt-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="As printed on the statement"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="stmt-ref">Reference (optional)</Label>
              <Input id="stmt-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="stmt-amount">Amount</Label>
              <Input
                id="stmt-amount"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="stmt-balance">Balance after (optional)</Label>
            <Input
              id="stmt-balance"
              type="number"
              step="0.01"
              value={balanceAfter}
              onChange={(e) => setBalanceAfter(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Add line
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
