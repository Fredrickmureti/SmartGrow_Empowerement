/**
 * BudgetCreatePage — full-page `/finance/budgets/new` route replacement
 * for `BudgetFormSheet` (create mode).
 *
 * Header-only create step: name, fiscal year, description. On success
 * we route straight to `/finance/budgets/:id/edit` so the user can add
 * budget items inline via the routed workspace — matches the Journal
 * Entry / Bank Account pattern (create → edit for line entry).
 *
 * Composed on `RecordFormShell` so the interaction language matches
 * every other Finance create surface.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";

import {
  FieldCell,
  FieldGrid,
  RecordFormShell,
  Section,
  useRecordFormSubmit,
} from "@/design-system";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

import { useBudgets, type Budget } from "@/hooks/useBudgets";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";

export default function BudgetCreatePage() {
  const navigate = useNavigate();
  const { createBudget, budgets } = useBudgets();
  const { periods } = useFiscalPeriods();
  const { allowed: canManageBudgets } = useFinancePermission(
    "finance.manage_budgets",
  );

  const currentYear = new Date().getFullYear();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fiscalYear, setFiscalYear] = useState<number>(currentYear);

  useEffect(() => {
    if (!canManageBudgets) {
      navigate("/finance/budgets", { replace: true });
    }
  }, [canManageBudgets, navigate]);

  const isFiscalYearClosed = (year: number): boolean =>
    periods.some(
      (p) =>
        p.period_type === "year" &&
        p.status === "closed" &&
        p.name.includes(year.toString()),
    );

  const yearOptions = useMemo(
    () => [currentYear - 1, currentYear, currentYear + 1, currentYear + 2],
    [currentYear],
  );

  const submit = useRecordFormSubmit<Budget | void>({
    entityLabel: "Budget",
    mode: "create",
    // Redirect into the edit workspace so lines can be added inline.
    redirectTo: (result) => {
      if (result && "id" in result && result.id) {
        return `/finance/budgets/${result.id}/edit`;
      }
      // Fallback: newest budget by created_at.
      const created = [...budgets].sort((a, b) =>
        (b.created_at || "").localeCompare(a.created_at || ""),
      )[0];
      return created ? `/finance/budgets/${created.id}/edit` : "/finance/budgets";
    },
  });

  // A period lock governs postings, not plans: a new budget is always a draft,
  // so a closed fiscal year is advisory here, never a block. The database
  // applies the same rule in `_budget_items_normalize`.
  const yearClosed = isFiscalYearClosed(fiscalYear);
  const trimmedName = name.trim();
  const submitDisabled = !trimmedName;


  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitDisabled) return;
    submit.run(async () => {
      const res = await createBudget.mutateAsync({
        name: trimmedName,
        fiscal_year: fiscalYear,
        description: description.trim() || undefined,
      });
      // useBudgets.createBudget resolves to the inserted row (data[0]).
      return (res as Budget | undefined) ?? undefined;
    });
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Budget"
      cancelHref="/finance/budgets"
      onSubmit={onSubmit}
      isSubmitting={submit.isSubmitting}
      submitDisabled={submitDisabled}
      submitLabel="Create budget"
      headerActions={<FinanceScopeBadge />}
    >
      <Section
        title="Budget details"
        description="Name and fiscal year are required. You'll add budget lines on the next step."
      >
        <div className="px-5 pb-5">
          <FieldGrid columns={2}>
            <FieldCell span="full">
              <div className="space-y-2">
                <Label htmlFor="budget-name">Budget name *</Label>
                <Input
                  id="budget-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., 2024 Operating Budget"
                  autoFocus
                  required
                />
              </div>
            </FieldCell>

            <div className="space-y-2">
              <Label htmlFor="budget-year">Fiscal year *</Label>
              <Select
                value={fiscalYear.toString()}
                onValueChange={(v) => setFiscalYear(parseInt(v, 10))}
              >
                <SelectTrigger id="budget-year">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions.map((y) => (
                    <SelectItem key={y} value={y.toString()}>
                      {y} {isFiscalYearClosed(y) ? "(Closed)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {yearClosed && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <AlertTriangle className="h-3 w-3" /> This fiscal year is
                  closed for posting. The plan can still be recorded.
                </p>
              )}

            </div>

            <div className="space-y-2">
              <Label>Initial status</Label>
              <Input value="Draft" disabled />
              <p className="text-xs text-muted-foreground">
                New budgets start as Draft. Activate from the record actions
                after adding lines.
              </p>
            </div>

            <FieldCell span="full">
              <div className="space-y-2">
                <Label htmlFor="budget-desc">Description</Label>
                <Textarea
                  id="budget-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="Optional context — planning assumptions, owner, etc."
                />
              </div>
            </FieldCell>
          </FieldGrid>
        </div>
      </Section>

      {!canManageBudgets && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            You lack the <code>finance.manage_budgets</code> permission.
            <Link to="/finance/budgets" className="ml-1 underline">
              Return to budgets
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}
    </RecordFormShell>
  );
}