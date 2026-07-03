/**
 * BudgetFormSheet — create/edit for a Budget header (name, fiscal year,
 * description). Mounted on the Enterprise UX `DetailSheet` primitive so
 * the interaction language matches the rest of Finance.
 *
 * URL-driven behind `?sheet=budget[&id=<uuid>]`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
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
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budget?: Budget | null;
}

export function BudgetFormSheet({ open, onOpenChange, budget }: Props) {
  const { createBudget, updateBudget } = useBudgets();
  const { periods } = useFiscalPeriods();
  const { toast } = useToast();
  const mode: "create" | "edit" = budget ? "edit" : "create";
  const currentYear = new Date().getFullYear();

  const [form, setForm] = useState({
    name: "",
    description: "",
    fiscal_year: currentYear,
    status: "draft" as string,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      name: budget?.name ?? "",
      description: budget?.description ?? "",
      fiscal_year: budget?.fiscal_year ?? currentYear,
      status: budget?.status ?? "draft",
    });
  }, [open, budget, currentYear]);

  const isFiscalYearClosed = (year: number): boolean =>
    periods.some(
      (p) =>
        p.period_type === "year" &&
        p.status === "closed" &&
        p.name.includes(year.toString()),
    );

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      if (mode === "edit" && budget) {
        if (isFiscalYearClosed(form.fiscal_year)) {
          toast({
            title: "Cannot edit",
            description: "This fiscal year is closed.",
            variant: "destructive",
          });
          return;
        }
        await updateBudget.mutateAsync({ id: budget.id, ...form });
        toast({ title: "Budget updated successfully" });
      } else {
        await createBudget.mutateAsync(form);
        toast({ title: "Budget created successfully" });
      }
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
      title={mode === "edit" ? "Edit budget" : "New budget"}
      description={
        mode === "edit"
          ? "Update budget details."
          : "Create a new budget for financial planning."
      }
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
                form="budget-form"
                disabled={isSubmitting}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === "edit" ? "Save changes" : "Create budget"}
              </Button>
            </ActionBar>
          }
        />
      }
    >
      <form id="budget-form" onSubmit={handleSubmit} className="space-y-4">
        <FieldGrid columns={2}>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="budget-name">Budget name *</Label>
              <Input
                id="budget-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g., 2024 Operating Budget"
                required
              />
            </div>
          </FieldCell>
          <div className="space-y-2">
            <Label htmlFor="budget-year">Fiscal year *</Label>
            <Select
              value={form.fiscal_year.toString()}
              onValueChange={(v) =>
                setForm({ ...form, fiscal_year: parseInt(v) })
              }
            >
              <SelectTrigger id="budget-year">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map(
                  (year) => (
                    <SelectItem key={year} value={year.toString()}>
                      {year} {isFiscalYearClosed(year) ? "(Closed)" : ""}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            {isFiscalYearClosed(form.fiscal_year) && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> This fiscal year is closed.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Input
              value={mode === "edit" ? form.status : "draft"}
              disabled
              className="capitalize"
            />
            <p className="text-xs text-muted-foreground">
              Use actions menu to change status.
            </p>
          </div>
          <FieldCell span="full">
            <div className="space-y-2">
              <Label htmlFor="budget-desc">Description</Label>
              <Textarea
                id="budget-desc"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                rows={3}
              />
            </div>
          </FieldCell>
        </FieldGrid>
      </form>
    </DetailSheet>
  );
}

export default BudgetFormSheet;
