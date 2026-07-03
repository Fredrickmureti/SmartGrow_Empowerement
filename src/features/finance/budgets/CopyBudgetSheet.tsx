/**
 * CopyBudgetSheet — clone an existing Budget's items into a new fiscal
 * year as a Draft. Mounted on DetailSheet.
 *
 * URL-driven behind `?sheet=copy&id=<source-uuid>`.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  DetailSheet,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: Budget | null;
}

export function CopyBudgetSheet({ open, onOpenChange, source }: Props) {
  const { createBudget } = useBudgets();
  const { toast } = useToast();
  const currentYear = new Date().getFullYear();
  const [targetYear, setTargetYear] = useState(currentYear + 1);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open && source) setTargetYear(source.fiscal_year + 1);
  }, [open, source]);

  const handleCopy = async () => {
    if (!source) return;
    setIsSubmitting(true);
    try {
      const newName = `${source.name} (Copy ${targetYear})`;
      const items = source.items?.map((item) => ({
        account_id: item.account_id,
        period_month: item.period_month,
        budgeted_amount: item.budgeted_amount,
        notes: item.notes || undefined,
      }));
      await createBudget.mutateAsync({
        name: newName,
        fiscal_year: targetYear,
        description: `Copied from ${source.name} (FY ${source.fiscal_year})`,
        items,
      });
      toast({ title: "Budget copied successfully" });
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
      title="Copy budget to new year"
      description={
        source
          ? `Copy all budget items from "${source.name}" to a new fiscal year.`
          : "Copy budget items to a new fiscal year."
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button onClick={handleCopy} disabled={isSubmitting || !source}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Copy budget
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Target fiscal year</Label>
          <Select
            value={targetYear.toString()}
            onValueChange={(v) => setTargetYear(parseInt(v))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map(
                (y) => (
                  <SelectItem key={y} value={y.toString()}>
                    {y}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">
          {source?.items?.length || 0} budget item(s) will be copied as a new
          Draft budget.
        </p>
      </div>
    </DetailSheet>
  );
}

export default CopyBudgetSheet;
