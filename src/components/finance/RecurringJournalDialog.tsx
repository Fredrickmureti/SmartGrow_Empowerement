import { useState } from "react";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { useAccounts } from "@/hooks/useAccounts";
import { useRecurringJournals, RecurringTemplateLine } from "@/hooks/useRecurringJournals";
import { format } from "date-fns";
import { Loader2, Plus, Trash2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RecurringJournalDialog({ open, onOpenChange }: Props) {
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

  const addLine = () => setLines([...lines, { account_id: "", debit: 0, credit: 0, description: "" }]);
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

  const handleSubmit = async () => {
    if (!name || !isBalanced) return;
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
    onOpenChange(false);
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Create Recurring Journal Entry"
      description="Template for entries that repeat on a schedule"
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <Button onClick={handleSubmit} disabled={createTemplate.isPending || !name || !isBalanced}>
              {createTemplate.isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</> : "Create Recurring Template"}
            </Button>
          }
        />
      }
    >
      <div className="space-y-4">

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Template Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g., Monthly Rent Accrual" />
            </div>
            <div className="space-y-1.5">
              <Label>Reference Prefix</Label>
              <Input value={referencePrefix} onChange={e => setReferencePrefix(e.target.value)} placeholder="e.g., RENT" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Frequency</Label>
              <Select value={frequency} onValueChange={(v: any) => setFrequency(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="annually">Annually</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Next Run Date</Label>
              <Input type="date" value={nextRunDate} onChange={e => setNextRunDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>End Date (optional)</Label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Switch checked={isAutoPost} onCheckedChange={setIsAutoPost} />
            <Label>Auto-post when due</Label>
          </div>

          {/* Lines */}
          <div className="space-y-2">
            <Label>Journal Lines</Label>
            {lines.map((line, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_100px_100px_auto] gap-2 items-end">
                <AccountCombobox accounts={accounts}
                  value={line.account_id}
                  onValueChange={(v) => updateLine(idx, "account_id", v)}
                  placeholder="Select account..."
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Debit"
                  value={line.debit || ""}
                  onChange={e => updateLine(idx, "debit", parseFloat(e.target.value) || 0)}
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Credit"
                  value={line.credit || ""}
                  onChange={e => updateLine(idx, "credit", parseFloat(e.target.value) || 0)}
                />
                <Button variant="ghost" size="icon" onClick={() => removeLine(idx)} disabled={lines.length <= 2}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus className="h-3 w-3 mr-1" /> Add Line
            </Button>
            <div className="flex justify-between text-sm pt-1">
              <span>Total Debit: {totalDebit.toFixed(2)}</span>
              <span>Total Credit: {totalCredit.toFixed(2)}</span>
              <span className={isBalanced ? "text-primary" : "text-destructive"}>
                {isBalanced ? "✓ Balanced" : "✗ Unbalanced"}
              </span>
            </div>
          </div>
      </div>
    </DetailSheet>

  );
}
