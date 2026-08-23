/**
 * BudgetEditPage — full-page `/finance/budgets/:id/edit` route
 * replacement for the trio of `BudgetFormSheet` (edit) + `ManageBudgetSheet`
 * (variance/chart view) + `BudgetItemSheet` (nested add-line modal).
 *
 * Sections:
 *   1. Details — header form (name, fiscal year, description) editable
 *      while the budget is Draft; read-only once Active/Closed.
 *   2. Budget lines — inline add-line composer + table of existing
 *      lines with row delete. Replaces the sheet-in-sheet BudgetItem
 *      modal.
 *   3. Analysis — variance summary cards + budget-vs-actual chart with
 *      a Calculate actuals action.
 *
 * Composed on `RecordFormShell` so the interaction language matches
 * every other Finance edit surface.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  Plus,
  Trash2,
  TrendingDown,
  TrendingUp,
  XCircle,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  ErrorState,
  FieldCell,
  FieldGrid,
  LoadingState,
  RecordFormShell,
  Section,
  useRecordFormSubmit,
} from "@/design-system";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

import { useBudgets, type Budget, type BudgetItem } from "@/hooks/useBudgets";
import { useAccounts } from "@/hooks/useAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import { useBudgetVsActual } from "@/hooks/useBudgetVsActual";
import { useBudgetRevisions } from "@/hooks/useBudgetRevisions";
import { useFinancePermission } from "@/hooks/finance/useFinancePermission";
import { FinanceScopeBadge } from "@/components/finance/FinanceScopeBadge";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export default function BudgetEditPage() {
  const { id: budgetId = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const {
    budgets,
    isLoading: budgetsLoading,
    updateBudget,
    activateBudget,
    closeBudget,
    upsertBudgetItem,
    deleteBudgetItem,
  } = useBudgets();
  const { accounts } = useAccounts();
  const { periods, isDateLocked } = useFiscalPeriods();
  const { formatCurrency } = useCurrency();
  const { allowed: canManageBudgets } = useFinancePermission(
    "finance.manage_budgets",
  );

  const budget = useMemo<Budget | null>(
    () => budgets.find((b) => b.id === budgetId) ?? null,
    [budgets, budgetId],
  );

  // Header form state (hydrated once budget arrives).
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fiscalYear, setFiscalYear] = useState<number>(
    new Date().getFullYear(),
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!budget || hydrated) return;
    setName(budget.name || "");
    setDescription(budget.description || "");
    setFiscalYear(budget.fiscal_year);
    setHydrated(true);
  }, [budget, hydrated]);

  // Add-line composer state (inline — replaces BudgetItemSheet modal).
  const [lineAccount, setLineAccount] = useState("");
  const [lineMonth, setLineMonth] = useState<number>(1);
  const [lineAmount, setLineAmount] = useState<string>("");
  const [lineNotes, setLineNotes] = useState("");
  const [addingLine, setAddingLine] = useState(false);

  const isReadOnly = !canManageBudgets || budget?.status === "closed";
  const isActive = budget?.status === "active";
  /**
   * A period lock governs postings, not plans. A DRAFT budget may be authored
   * across periods that are already closed (prior-year plans, onboarding
   * back-loads). Once the budget is in force, a closed period's plan line is
   * frozen — the database enforces the same rule in `_budget_items_normalize`.
   */
  const isDraft = budget?.status === "draft";

  const isFiscalYearClosed = (year: number): boolean =>
    periods.some(
      (p) =>
        p.period_type === "year" &&
        p.status === "closed" &&
        p.name.includes(year.toString()),
    );


  const currentYear = new Date().getFullYear();
  const yearOptions = useMemo(
    () => [currentYear - 1, currentYear, currentYear + 1, currentYear + 2],
    [currentYear],
  );

  // Header submit — updates name / fiscal_year / description.
  const submit = useRecordFormSubmit<void>({
    entityLabel: "Budget",
    mode: "edit",
    redirectTo: () => "/finance/budgets",
  });

  const trimmedName = name.trim();
  const headerSubmitDisabled =
    isReadOnly ||
    !trimmedName ||
    (budget && !isDraft ? isFiscalYearClosed(fiscalYear) : false);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!budget || headerSubmitDisabled) return;
    submit.run(async () => {
      await updateBudget.mutateAsync({
        id: budget.id,
        name: trimmedName,
        fiscal_year: fiscalYear,
        description: description.trim() || undefined,
      });
    });
  };

  const handleAddLine = async () => {
    if (!budget || !lineAccount || !lineAmount) return;
    if (budget.status === "closed") return;
    const monthDate = `${budget.fiscal_year}-${String(lineMonth).padStart(2, "0")}-15`;
    if (!isDraft && isDateLocked(monthDate)) {
      toast({
        title: "Period locked",
        description: `The fiscal period for ${MONTHS[lineMonth - 1]} ${budget.fiscal_year} is closed. Record a budget revision instead.`,
        variant: "destructive",
      });
      return;
    }
    setAddingLine(true);

    try {
      await upsertBudgetItem.mutateAsync({
        budget_id: budget.id,
        account_id: lineAccount,
        period_month: lineMonth,
        budgeted_amount: parseFloat(lineAmount) || 0,
        notes: lineNotes || undefined,
      });
      toast({ title: "Budget line saved" });
      // Reset add-line composer but keep account+month for rapid entry.
      setLineAmount("");
      setLineNotes("");
    } catch (err) {
      toast({
        title: "Error",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setAddingLine(false);
    }
  };

  const handleDeleteLine = async (itemId: string) => {
    try {
      await deleteBudgetItem.mutateAsync(itemId);
      toast({ title: "Budget line removed" });
    } catch (err) {
      toast({
        title: "Error",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  };

  const handleActivate = async () => {
    if (!budget) return;
    if (!budget.items || budget.items.length === 0) {
      toast({
        title: "Cannot activate",
        description: "Add at least one budget line before activating.",
        variant: "destructive",
      });
      return;
    }
    try {
      await activateBudget.mutateAsync(budget.id);
      toast({ title: "Budget activated" });
    } catch (err) {
      toast({
        title: "Error",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  };

  const handleClose = async () => {
    if (!budget) return;
    try {
      await closeBudget.mutateAsync(budget.id);
      toast({ title: "Budget closed" });
    } catch (err) {
      toast({
        title: "Error",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    }
  };

  // Analysis — every figure comes from the authoritative database report.
  const { report: varianceReport, isLoading: varianceLoading } = useBudgetVsActual(budget?.id);
  const { revisions, isLoading: revisionsLoading } = useBudgetRevisions(budget?.id);

  const items: BudgetItem[] = budget?.items || [];

  /**
   * Budget Schedule export — the approved PLAN as a document, with no
   * actuals in it.
   *
   * This is deliberately a SERVER-BUILD config: no rows or columns are
   * shipped from the browser. `render-report` calls `get_budget_schedule`
   * and `get_budget_document_header`, so the PDF a controller circulates,
   * the workbook a planner flexes and the CSV another system ingests are
   * three renderings of one server answer — not three re-reads of a moving
   * database. The branch is the BUDGET's own branch, never the ambient
   * branch switcher, so a company-wide budget never prints as a branch one.
   */
  const getScheduleExportConfig = useCallback((): ExportConfig => {
    return {
      title: `Budget Schedule – ${budget?.name || ""}`,
      reportType: "budget_schedule",
      dateFrom: `${budget?.fiscal_year}-01-01`,
      dateTo: `${budget?.fiscal_year}-12-31`,
      dateRange: `Fiscal Year ${budget?.fiscal_year ?? ""}`,
      branchId: budget?.branch_id ?? null,
      filters: { budgetId: budget?.id },
      sheetName: "Budget Schedule",
      columns: [],
      rows: [],
    } as ExportConfig;
  }, [budget?.name, budget?.fiscal_year, budget?.branch_id, budget?.id]);


  const getAccountName = (accountId: string) => {
    const account = accounts.find((a) => a.id === accountId);
    return account ? `${account.code} - ${account.name}` : "Unknown account";
  };

  const getVarianceForItem = (accountId: string, month: number) =>
    varianceReport?.rows.find((r) => r.accountId === accountId && r.month === month);

  /**
   * Revenue and cost are charted as separate series. They are never summed:
   * income is credit-normal and expense is debit-normal, so a combined bar
   * would carry no accounting meaning (see the favourable-positive invariant
   * in the budget domain plan).
   */
  const chartData = useMemo(() => {
    if (!varianceReport) {
      const typeOf = (accountId: string) =>
        accounts.find((a) => a.id === accountId)?.account_type;
      return MONTHS.map((month, index) => {
        const monthItems = items.filter((it) => it.period_month === index + 1);
        const sumFor = (t: string) =>
          monthItems
            .filter((i) => typeOf(i.account_id) === t)
            .reduce((sum, i) => sum + i.budgeted_amount, 0);
        return {
          month: month.substring(0, 3),
          revenuePlan: sumFor("income"),
          revenueActual: 0,
          costPlan: sumFor("expense"),
          costActual: 0,
        };
      });
    }
    return varianceReport.expenseByMonth.map((point, index) => {
      const income = varianceReport.incomeByMonth[index];
      return {
        month: point.month,
        revenuePlan: income?.budgeted ?? 0,
        revenueActual: income?.actual ?? 0,
        costPlan: point.budgeted,
        costActual: point.actual,
      };
    });
  }, [varianceReport, items, accounts]);


  const getStatusBadge = (status: string) => {
    switch (status) {
      case "active":
        return <Badge className="bg-primary/10 text-primary">Active</Badge>;
      case "closed":
        return <Badge variant="secondary">Closed</Badge>;
      default:
        return <Badge variant="outline">Draft</Badge>;
    }
  };

  if (budgetsLoading && !budget) {
    return <LoadingState />;
  }

  if (!budget) {
    return (
      <ErrorState
        title="Budget not found"
        description="This budget may have been deleted or you don't have access."
        onRetry={() => navigate("/finance/budgets")}
      />
    );
  }

  const revenueOrExpenseAccounts = accounts.filter(
    (a) => a.account_type === "expense" || a.account_type === "income",
  );

  const canAddLine =
    !isReadOnly &&
    !!lineAccount &&
    !!lineAmount &&
    parseFloat(lineAmount) > 0;

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Budget"
      recordRef={budget.name}
      meta={
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          FY {budget.fiscal_year} {getStatusBadge(budget.status)}
          <FinanceScopeBadge />
        </span>
      }
      cancelHref="/finance/budgets"
      onSubmit={onSubmit}
      isSubmitting={submit.isSubmitting}
      submitDisabled={headerSubmitDisabled}
      submitLabel="Save changes"
      extraLeadingActions={
        canManageBudgets && budget.status === "draft" ? (
          <Button
            type="button"
            variant="outline"
            onClick={handleActivate}
            disabled={activateBudget.isPending}
          >
            {activateBudget.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle className="mr-2 h-4 w-4" />
            )}
            Activate
          </Button>
        ) : canManageBudgets && isActive ? (
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={closeBudget.isPending}
          >
            {closeBudget.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <XCircle className="mr-2 h-4 w-4" />
            )}
            Close budget
          </Button>
        ) : undefined
      }
    >
      {/* Section 1 — Details */}
      <Section
        title="Details"
        description={
          budget.status === "closed"
            ? "This budget is closed and read-only."
            : isActive
              ? "Header details may still be updated; new lines require a new draft budget."
              : "Draft budgets are fully editable."
        }
      >
        <div className="px-5 pb-5">
          <FieldGrid columns={2}>
            <FieldCell span="full">
              <div className="space-y-2">
                <Label htmlFor="b-name">Budget name *</Label>
                <Input
                  id="b-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isReadOnly}
                  required
                />
              </div>
            </FieldCell>
            <div className="space-y-2">
              <Label htmlFor="b-year">Fiscal year *</Label>
              <Select
                value={fiscalYear.toString()}
                onValueChange={(v) => setFiscalYear(parseInt(v, 10))}
                disabled={isReadOnly}
              >
                <SelectTrigger id="b-year">
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
              {isFiscalYearClosed(fiscalYear) && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <AlertTriangle className="h-3 w-3" />
                  {isDraft
                    ? "This fiscal year is closed for posting. The plan can still be recorded."
                    : "Fiscal year is closed; change plan lines through a revision."}
                </p>
              )}

            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Input value={budget.status} disabled className="capitalize" />
            </div>
            <FieldCell span="full">
              <div className="space-y-2">
                <Label htmlFor="b-desc">Description</Label>
                <Textarea
                  id="b-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  disabled={isReadOnly}
                />
              </div>
            </FieldCell>
          </FieldGrid>
        </div>
      </Section>

      {/* Section 2 — Budget lines (inline add + table, no modal) */}
      <Section
        title="Budget lines"
        description="Add one row per account / month. Replaces the legacy pop-up."
        actions={
          <span className="text-xs text-muted-foreground">
            {items.length} line{items.length === 1 ? "" : "s"}
          </span>
        }
      >
        <div className="space-y-4 px-5 pb-5">
          {!isReadOnly && (
            <div className="rounded-md border bg-muted/20 p-3">
              <FieldGrid columns={4}>
                <FieldCell span={2}>
                  <div className="space-y-1.5">
                    <Label htmlFor="add-account" className="text-xs">
                      Account
                    </Label>
                    <Select
                      value={lineAccount}
                      onValueChange={setLineAccount}
                    >
                      <SelectTrigger id="add-account">
                        <SelectValue placeholder="Select account" />
                      </SelectTrigger>
                      <SelectContent>
                        {revenueOrExpenseAccounts.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.code} - {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </FieldCell>
                <div className="space-y-1.5">
                  <Label htmlFor="add-month" className="text-xs">
                    Month
                  </Label>
                  <Select
                    value={lineMonth.toString()}
                    onValueChange={(v) => setLineMonth(parseInt(v, 10))}
                  >
                    <SelectTrigger id="add-month">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m, i) => {
                        const monthDate = `${budget.fiscal_year}-${String(i + 1).padStart(2, "0")}-15`;
                        // Locked periods stay selectable while the budget is a
                        // draft — planning is not posting.
                        const locked = !isDraft && isDateLocked(monthDate);
                        return (
                          <SelectItem
                            key={i + 1}
                            value={(i + 1).toString()}
                            disabled={locked}
                          >
                            {m} {locked ? "(Locked)" : ""}
                          </SelectItem>
                        );
                      })}

                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="add-amount" className="text-xs">
                    Amount
                  </Label>
                  <Input
                    id="add-amount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={lineAmount}
                    onChange={(e) => setLineAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <FieldCell span={3}>
                  <div className="space-y-1.5">
                    <Label htmlFor="add-notes" className="text-xs">
                      Notes (optional)
                    </Label>
                    <Input
                      id="add-notes"
                      value={lineNotes}
                      onChange={(e) => setLineNotes(e.target.value)}
                    />
                  </div>
                </FieldCell>
                <div className="flex items-end">
                  <Button
                    type="button"
                    onClick={handleAddLine}
                    disabled={!canAddLine || addingLine}
                    className="w-full"
                  >
                    {addingLine ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4" />
                    )}
                    Add line
                  </Button>
                </div>
              </FieldGrid>
              <p className="mt-2 text-xs text-muted-foreground">
                Adding a line saves immediately. Existing account+month
                combinations are upserted.
              </p>
            </div>
          )}

          {items.length === 0 ? (
            <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
              No budget lines yet.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Budgeted</TableHead>
                    <TableHead className="text-right">Actual</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead>Notes</TableHead>
                    {!isReadOnly && <TableHead className="w-10" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...items]
                    .sort((a, b) => a.period_month - b.period_month)
                    .map((item) => {
                      const row = getVarianceForItem(
                        item.account_id,
                        item.period_month,
                      );
                      const actual = row?.actual ?? 0;
                      // Favourable-positive variance, computed in SQL by
                      // account nature — never re-derived here.
                      const variance = row?.variance ?? 0;
                      const hasActual = !!row && !varianceLoading;
                      return (
                        <TableRow key={item.id}>
                          <TableCell>
                            {getAccountName(item.account_id)}
                          </TableCell>
                          <TableCell>{MONTHS[item.period_month - 1]}</TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            {formatCurrency(item.budgeted_amount)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {hasActual ? (
                              formatCurrency(actual)
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                —
                              </span>
                            )}
                          </TableCell>
                          <TableCell
                            className={`text-right tabular-nums font-medium ${
                              hasActual
                                ? variance >= 0
                                  ? "text-primary"
                                  : "text-destructive"
                                : ""
                            }`}
                          >
                            {hasActual ? (
                              <span className="flex items-center justify-end gap-1">
                                {variance > 0 && (
                                  <TrendingDown className="h-3 w-3" />
                                )}
                                {variance < 0 && (
                                  <TrendingUp className="h-3 w-3" />
                                )}
                                {formatCurrency(variance)}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                —
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-xs truncate text-muted-foreground">
                            {item.notes || "—"}
                          </TableCell>
                          {!isReadOnly && (
                            <TableCell>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDeleteLine(item.id)}
                                disabled={deleteBudgetItem.isPending}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </div>
          )}

        </div>
      </Section>

      {/* Section 3 — Analysis */}
      <Section
        title="Analysis"
        description="Live budget vs actual variance, computed from posted ledger activity. Positive variance is favourable."
        actions={
          varianceLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : undefined
        }
      >
        <div className="space-y-4 px-5 pb-5">
          {varianceReport && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  { label: "Revenue plan", totals: varianceReport.income },
                  { label: "Cost plan", totals: varianceReport.expense },
                  { label: "Net result", totals: varianceReport.net },
                ] as const
              ).map(({ label, totals }) => (
                <Card key={label} className="p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-lg font-bold tabular-nums">
                    {formatCurrency(totals.actual)}
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    plan {formatCurrency(totals.budgeted)}
                  </p>
                  <p
                    className={`text-xs font-medium tabular-nums ${
                      totals.favourable ? "text-primary" : "text-destructive"
                    }`}
                  >
                    {formatCurrency(totals.variance)}
                    {totals.variancePercent !== null
                      ? ` (${totals.variancePercent.toFixed(1)}%)`
                      : ""}
                  </p>
                </Card>
              ))}
              <Card className="p-3">
                <p className="text-xs text-muted-foreground">Unbudgeted lines</p>
                <p className="text-lg font-bold tabular-nums">
                  {varianceReport.unbudgetedRows.length}
                </p>
                <p className="text-xs text-muted-foreground">
                  Ledger activity with no plan
                </p>
              </Card>
            </div>
          )}

          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip
                  formatter={(value: number) => formatCurrency(value)}
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                  }}
                />
                <Legend />
                <Bar
                  dataKey="revenuePlan"
                  fill="hsl(var(--primary))"
                  name="Revenue plan"
                />
                <Bar
                  dataKey="revenueActual"
                  fill="hsl(var(--primary) / 0.5)"
                  name="Revenue actual"
                />
                <Bar
                  dataKey="costPlan"
                  fill="hsl(var(--muted-foreground))"
                  name="Cost plan"
                />
                <Bar
                  dataKey="costActual"
                  fill="hsl(var(--destructive))"
                  name="Cost actual"
                />

              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </Section>

      {/* Section 4 — Revision history (post-activation change is never in-place) */}
      <Section
        title="Revision history"
        description="Every change made after activation, recorded by apply_budget_revision."
      >
        <div className="px-5 pb-5">
          {revisionsLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading revisions…
            </div>
          ) : revisions.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No revisions. The plan is as originally approved.
            </p>
          ) : (
            <div className="space-y-4">
              {revisions.map((rev) => (
                <div key={rev.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      Revision {rev.revision_number}
                      {rev.reason ? ` — ${rev.reason}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(rev.created_at).toLocaleString()}
                    </p>
                  </div>
                  {rev.note && (
                    <p className="mt-1 text-xs text-muted-foreground">{rev.note}</p>
                  )}
                  <Table className="mt-2">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead>Period</TableHead>
                        <TableHead className="text-right">Previous</TableHead>
                        <TableHead className="text-right">New</TableHead>
                        <TableHead className="text-right">Change</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rev.lines.map((line) => {
                        const previous = line.previous_amount ?? 0;
                        const next = line.new_amount ?? 0;
                        return (
                          <TableRow key={line.id}>
                            <TableCell className="text-sm">
                              {line.accounts
                                ? `${line.accounts.code} - ${line.accounts.name}`
                                : getAccountName(line.account_id)}
                            </TableCell>
                            <TableCell className="text-sm">
                              {MONTHS[line.period_month - 1] ?? line.period_month}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCurrency(previous)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCurrency(next)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCurrency(next - previous)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>

      {!canManageBudgets && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            You lack the <code>finance.manage_budgets</code> permission — this
            budget is read-only.
            <Link to="/finance/budgets" className="ml-1 underline">
              Back to list
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}
    </RecordFormShell>
  );
}