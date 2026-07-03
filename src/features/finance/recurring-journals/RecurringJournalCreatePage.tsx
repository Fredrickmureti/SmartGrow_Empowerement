/**
 * RecurringJournalCreatePage — routed create surface at
 * `/finance/recurring-journals/new`. Composes `RecordFormShell`
 * with the template form previously in the legacy
 * `RecurringJournalDialog`. All `useRecurringJournals.createTemplate`
 * business logic (mutation payload, toast wording, cache invalidation)
 * is preserved verbatim.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  RecordFormShell,
  Section,
  FieldGrid,
  FieldCell,
} from "@/design-system";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { useAccounts } from "@/hooks/useAccounts";
import {
  useRecurringJournals,
  type RecurringTemplateLine,
} from "@/hooks/useRecurringJournals";

export default function RecurringJournalCreatePage() {
  const navigate = useNavigate();
  const { createTemplate } = useRecurringJournals();
  const { accounts } = useAccounts();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [frequency, setFrequency] = useState<"monthly" | "quarterly" | "annually">("monthly");
  const [nextRunDate, setNextRunDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [endDate, setEndDate] = useState("");
  const [isAutoPost, setIsAutoPost] = useState(false);
  const [referencePrefix, setReferencePrefix] = useState("");
  const [lines, setLines] = useState<RecurringTemplateLine[]>([
    { account_id: "", debit: 0, credit: 0, description: "" },
    { account_id: "", debit: 0, credit: 0, description: "" },
  ]);

  const addLine = () =>
    setLines([...lines, { account_id: "", debit: 0, credit: 0, description: "" }]);
  const removeLine = (idx: number) => {
    if (lines.length <= 2) return;
    setLines(lines.filter((_, i) => i !== idx));
  };
  const updateLine = (idx: number, field: keyof RecurringTemplateLine, value: any) => {
    const updated = [...lines];
    (updated[idx] as any)[field] = value;
    setLines(updated);
  };

  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;
  const submitDisabled = !name || !isBalanced;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitDisabled) return;
    await createTemplate.mutateAsync({
      template_name: name,
      description,
      frequency,
      next_run_date: nextRunDate,
      end_date: endDate || undefined,
      is_auto_post: isAutoPost,
      reference_prefix: referencePrefix || undefined,
      lines,
    });
    navigate("/finance/journal-entries");
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Recurring Journal"
      meta="Template for entries that repeat on a schedule"
      cancelHref="/finance/journal-entries"
      onSubmit={handleSubmit}
      isSubmitting={createTemplate.isPending}
      submitDisabled={submitDisabled}
      submitLabel={createTemplate.isPending ? "Creating…" : "Create Recurring Template"}
    >
      <Section title="Template">
        <FieldGrid columns={3}>
          <div className="space-y-2">
            <Label htmlFor="rj_name">Template Name *</Label>
            <Input
              id="rj_name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Monthly Rent Accrual"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rj_prefix">Reference Prefix</Label>
            <Input
              id="rj_prefix"
              value={referencePrefix}
              onChange={(e) => setReferencePrefix(e.target.value)}
              placeholder="e.g., RENT"
            />
          </div>
          <div className="flex items-end">
            <div className="flex items-center gap-2 pb-2">
              <Switch checked={isAutoPost} onCheckedChange={setIsAutoPost} id="rj_autopost" />
              <Label htmlFor="rj_autopost">Auto-post when due</Label>
            </div>
          </div>
          <FieldCell span={3}>
            <div className="space-y-2">
              <Label htmlFor="rj_desc">Description</Label>
              <Input
                id="rj_desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description"
              />
            </div>
          </FieldCell>
        </FieldGrid>
      </Section>

      <Section title="Schedule">
        <FieldGrid columns={3}>
          <div className="space-y-2">
            <Label>Frequency *</Label>
            <Select value={frequency} onValueChange={(v: any) => setFrequency(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
                <SelectItem value="annually">Annually</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="rj_next">Next Run Date *</Label>
            <Input
              id="rj_next"
              type="date"
              value={nextRunDate}
              onChange={(e) => setNextRunDate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rj_end">End Date (optional)</Label>
            <Input
              id="rj_end"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </FieldGrid>
      </Section>

      <Section
        title="Journal Lines"
        description="Debits must equal credits for the template to be valid."
        actions={
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus className="h-4 w-4 mr-1" /> Add Line
          </Button>
        }
      >
        <div className="space-y-2">
          {lines.map((line, idx) => (
            <div
              key={idx}
              className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_120px_120px_auto] gap-2 items-end"
            >
              <div className="space-y-1">
                <Label className="text-xs sm:sr-only">Account</Label>
                <AccountCombobox
                  accounts={accounts}
                  value={line.account_id}
                  onValueChange={(v) => updateLine(idx, "account_id", v)}
                  placeholder="Select account..."
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs sm:sr-only">Debit</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Debit"
                  value={line.debit || ""}
                  onChange={(e) =>
                    updateLine(idx, "debit", parseFloat(e.target.value) || 0)
                  }
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs sm:sr-only">Credit</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Credit"
                  value={line.credit || ""}
                  onChange={(e) =>
                    updateLine(idx, "credit", parseFloat(e.target.value) || 0)
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeLine(idx)}
                disabled={lines.length <= 2}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap justify-between gap-3 text-sm pt-2 border-t">
            <span>Total Debit: {totalDebit.toFixed(2)}</span>
            <span>Total Credit: {totalCredit.toFixed(2)}</span>
            <span className={isBalanced ? "text-primary" : "text-destructive"}>
              {isBalanced ? "✓ Balanced" : "✗ Unbalanced"}
            </span>
          </div>
        </div>
      </Section>
    </RecordFormShell>
  );
}