/**
 * BudgetItemSheet — add a single line item to a budget. Mounted on
 * DetailSheet. Nested inside the Manage Budget sheet flow.
 *
 * URL-driven behind `?sheet=item&id=<budget-uuid>`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  DetailSheet,
  FieldGrid,
  FieldCell,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
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
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { useBudgets, type Budget } from "@/hooks/useBudgets";
import { useAccounts } from "@/hooks/useAccounts";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget: Budget | null;
}

export function BudgetItemSheet({ open, onOpenChange, budget }: Props) {
  const { upsertBudgetItem } = useBudgets();
  const { accounts } = useAccounts();
  const { isDateLocked } = useFiscalPeriods();
  const { toast } = useToast();

  const [form, setForm] = useState({
    account_id: "",
    period_month: 1,
    budgeted_amount: 0,
    notes: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({ account_id: "", period_month: 1, budgeted_amount: 0, notes: "" });
    }
  }, [open]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!budget) return;
    if (budget.status === "closed") {
      toast({
        title: "Cannot add items",
        description: "This budget is closed.",
        variant: "destructive",
      });
      return;
    }
    const monthDate = `${budget.fiscal_year}-${String(form.period_month).padStart(2, "0")}-15`;
    if (isDateLocked(monthDate)) {
      toast({
        title: "Period locked",
        description: `The fiscal period for ${MONTHS[form.period_month - 1]} ${budget.fiscal_year} is closed.`,
        variant: "destructive",
      });
      return;
    }
    setIsSubmitting(true);
    try {
      await upsertBudgetItem.mutateAsync({
        budget_id: budget.id,
        account_id: form.account_id,
        period_month: form.period_month,
        budgeted_amount: form.budgeted_amount,
        notes: form.notes,
      });
      toast({ title: "Budget item saved successfully" });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Error",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title="Add budget item"
      description="Add a new line item to the budget."
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="budget-item-form"
                disabled={isSubmitting || !form.account_id}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add item
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <form
        id="budget-item-form"
        onSubmit={handleSubmit}
        className="space-y-4"
      >
        <FieldGrid columns={2}>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="bi-account">Account *</Label>
              <Select
                value={form.account_id}
                onValueChange={(v) => setForm({ ...form, account_id: v })}
              >
                <SelectTrigger id="bi-account">
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {accounts
                    .filter(
                      (a) =>
                        a.account_type === "expense" ||
                        a.account_type === "income",
                    )
                    .map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.code} - {account.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </FieldCell>
          <div className="space-y-2">
            <Label htmlFor="bi-month">Month *</Label>
            <Select
              value={form.period_month.toString()}
              onValueChange={(v) =>
                setForm({ ...form, period_month: parseInt(v) })
              }
            >
              <SelectTrigger id="bi-month">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((month, index) => {
                  const monthDate = budget
                    ? `${budget.fiscal_year}-${String(index + 1).padStart(2, "0")}-15`
                    : "";
                  const locked = monthDate ? isDateLocked(monthDate) : false;
                  return (
                    <SelectItem
                      key={index + 1}
                      value={(index + 1).toString()}
                      disabled={locked}
                    >
                      {month} {locked ? "(Locked)" : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bi-amount">Budgeted amount *</Label>
            <Input
              id="bi-amount"
              type="number"
              step="0.01"
              min="0"
              value={form.budgeted_amount}
              onChange={(e) =>
                setForm({
                  ...form,
                  budgeted_amount: parseFloat(e.target.value) || 0,
                })
              }
              required
            />
          </div>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="bi-notes">Notes</Label>
              <Textarea
                id="bi-notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                rows={2}
              />
            </div>
          </FieldCell>
        </FieldGrid>
      </form>
    </DetailSheet>
  );
}

export default BudgetItemSheet;
