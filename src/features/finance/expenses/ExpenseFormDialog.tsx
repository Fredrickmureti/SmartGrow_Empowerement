/**
 * Expense capture / edit dialog.
 *
 * Commercial fields only. Status, numbering, tax and base amounts and the
 * ledger entry are all server-owned (`expense_submit` / `expense_approve`).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Loader2 } from "lucide-react";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import type { Expense, ExpenseCategory } from "@/hooks/useExpenses";

export interface ExpenseFormValues {
  expense_date: string;
  category_id: string | null;
  account_id: string | null;
  payment_account_id: string | null;
  amount: number;
  currency: string;
  description: string;
  reference: string | null;
  payment_method: string;
  receipt_url: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: ExpenseCategory[];
  expense?: Expense | null;
  /** `submit` asks the server to route the expense for approval immediately. */
  onSave: (values: ExpenseFormValues, submit: boolean) => Promise<void>;
}

const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "mpesa", label: "M-Pesa" },
  { value: "cheque", label: "Cheque" },
  { value: "card", label: "Card" },
];

const today = () => new Date().toISOString().slice(0, 10);

export function ExpenseFormDialog({
  open,
  onOpenChange,
  categories,
  expense,
  onSave,
}: Props) {
  const { accounts } = useAccounts();
  const { baseCurrency } = useCurrency();
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState<ExpenseFormValues>({
    expense_date: today(),
    category_id: null,
    account_id: null,
    payment_account_id: null,
    amount: 0,
    currency: baseCurrency || "KES",
    description: "",
    reference: null,
    payment_method: "cash",
    receipt_url: null,
  });

  useEffect(() => {
    if (!open) return;
    setValues({
      expense_date: expense?.expense_date ?? today(),
      category_id: expense?.category_id ?? null,
      account_id: expense?.account_id ?? null,
      payment_account_id: expense?.payment_account_id ?? null,
      amount: Number(expense?.amount ?? 0),
      currency: expense?.currency ?? baseCurrency ?? "KES",
      description: expense?.description ?? "",
      reference: expense?.reference ?? null,
      payment_method: expense?.payment_method ?? "cash",
      receipt_url: expense?.receipt_url ?? null,
    });
  }, [open, expense, baseCurrency]);

  const set = <K extends keyof ExpenseFormValues>(k: K, v: ExpenseFormValues[K]) =>
    setValues((p) => ({ ...p, [k]: v }));

  const valid =
    values.description.trim().length > 0 &&
    values.amount > 0 &&
    !!values.expense_date &&
    !!values.account_id;

  const save = async (submit: boolean) => {
    if (!valid) return;
    setSaving(true);
    try {
      await onSave(values, submit);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{expense ? "Edit expense" : "Record expense"}</DialogTitle>
          <DialogDescription>
            Capture what was spent. Approval and the ledger entry are handled by
            the system once the expense is submitted.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="expense-date">Date</Label>
            <Input
              id="expense-date"
              type="date"
              value={values.expense_date}
              onChange={(e) => set("expense_date", e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="expense-amount">Amount</Label>
            <Input
              id="expense-amount"
              type="number"
              min={0}
              step="0.01"
              value={values.amount || ""}
              onChange={(e) => set("amount", Number(e.target.value))}
            />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="expense-description">Description</Label>
            <Textarea
              id="expense-description"
              rows={2}
              placeholder="What was this spent on?"
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Category</Label>
            <Select
              value={values.category_id ?? "none"}
              onValueChange={(v) => set("category_id", v === "none" ? null : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Uncategorised" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Uncategorised</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Expense account</Label>
            <AccountCombobox
              accounts={accounts}
              value={values.account_id ?? ""}
              onValueChange={(v) => set("account_id", v || null)}
              allowedTypes={["expense"]}
              placeholder="Select expense account..."
            />
          </div>

          <div className="space-y-2">
            <Label>Paid from</Label>
            <AccountCombobox
              accounts={accounts}
              value={values.payment_account_id ?? ""}
              onValueChange={(v) => set("payment_account_id", v || null)}
              allowedTypes={["asset", "liability"]}
              placeholder="Cash / bank account..."
            />
          </div>

          <div className="space-y-2">
            <Label>Payment method</Label>
            <Select
              value={values.payment_method}
              onValueChange={(v) => set("payment_method", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="expense-reference">Reference</Label>
            <Input
              id="expense-reference"
              placeholder="Receipt or voucher number"
              value={values.reference ?? ""}
              onChange={(e) => set("reference", e.target.value || null)}
            />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="expense-receipt">Receipt link (optional)</Label>
            <Input
              id="expense-receipt"
              placeholder="https://…"
              value={values.receipt_url ?? ""}
              onChange={(e) => set("receipt_url", e.target.value || null)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          {!expense && (
            <Button variant="secondary" onClick={() => save(false)} disabled={!valid || saving}>
              Save as draft
            </Button>
          )}
          <Button onClick={() => save(!expense)} disabled={!valid || saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {expense ? "Save changes" : "Save and submit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
