/**
 * YearEndClosePage — full-page WizardShell replacement for the legacy
 * `YearEndClosingDialog`. Route: `/finance/fiscal-periods/close`.
 *
 * Steps:
 *   1. Scope   — pick fiscal year + retained-earnings account.
 *   2. Preview — GL-derived closing entry preview.
 *   3. Confirm — closing notes + final commit.
 *
 * All business logic (fetching balances, posting the closing JE, locking
 * child periods) is delegated to `useYearEndClosing` unchanged — this
 * page only reshapes the interaction.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { format, endOfYear } from "date-fns";
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckCircle2,
  FileText,
  Loader2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  ActionBar,
  FooterActionBar,
  RecordHeader,
  Section,
  WizardShell,
  WizardStepper,
  type WizardStep,
} from "@/design-system";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import { useYearEndClosing } from "@/hooks/useYearEndClosing";

const STEPS: WizardStep[] = [
  { id: "scope", label: "Scope", description: "Choose fiscal year" },
  { id: "preview", label: "Preview", description: "Review closing entry" },
  { id: "confirm", label: "Confirm", description: "Post & lock" },
];

type StepId = "scope" | "preview" | "confirm";

export default function YearEndClosePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselectedYear = searchParams.get("year");

  const { periods } = useFiscalPeriods();
  const {
    retainedEarningsAccounts,
    calculateClosingTotals,
    getQuickPreview,
    performYearEndClosing,
    isClosing,
  } = useYearEndClosing();

  const currentYear = new Date().getFullYear();
  const availableYears = Array.from({ length: 5 }, (_, i) => currentYear - 1 - i);

  const [step, setStep] = useState<StepId>("scope");
  const [completedStepIds, setCompletedStepIds] = useState<string[]>([]);
  const [selectedYear, setSelectedYear] = useState(
    preselectedYear ?? (currentYear - 1).toString(),
  );
  const [retainedEarningsId, setRetainedEarningsId] = useState("");
  const [notes, setNotes] = useState("");
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [glPreview, setGlPreview] = useState<ReturnType<typeof getQuickPreview> | null>(null);

  useEffect(() => {
    if (retainedEarningsAccounts.length > 0 && !retainedEarningsId) {
      setRetainedEarningsId(retainedEarningsAccounts[0].id);
    }
  }, [retainedEarningsAccounts, retainedEarningsId]);

  // Fetch GL-derived preview when entering the preview step or year changes.
  useEffect(() => {
    if (step !== "preview") return;
    setIsLoadingPreview(true);
    calculateClosingTotals(parseInt(selectedYear))
      .then((r) => setGlPreview(r))
      .catch(() => setGlPreview(getQuickPreview()))
      .finally(() => setIsLoadingPreview(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selectedYear]);

  const closingPreview = glPreview || getQuickPreview();

  const fiscalYearPeriod = useMemo(
    () =>
      periods.find(
        (p) => p.period_type === "year" && p.name.includes(selectedYear),
      ),
    [periods, selectedYear],
  );
  const isYearAlreadyClosed = fiscalYearPeriod?.status === "closed";

  const handleNext = () => {
    if (step === "scope") {
      if (!retainedEarningsId || isYearAlreadyClosed) return;
      setCompletedStepIds((s) => Array.from(new Set([...s, "scope"])));
      setStep("preview");
    } else if (step === "preview") {
      const hasWork =
        closingPreview.incomeAccountsCount + closingPreview.expenseAccountsCount > 0;
      if (!hasWork || isLoadingPreview) return;
      setCompletedStepIds((s) => Array.from(new Set([...s, "preview"])));
      setStep("confirm");
    }
  };

  const handleBack = () => {
    if (step === "confirm") setStep("preview");
    else if (step === "preview") setStep("scope");
  };

  const handleStepClick = (id: string) => {
    setStep(id as StepId);
  };

  const handleSubmit = async () => {
    if (!retainedEarningsId) return;
    const closingDate = format(
      endOfYear(new Date(parseInt(selectedYear), 0, 1)),
      "yyyy-MM-dd",
    );
    const result = await performYearEndClosing.mutateAsync({
      fiscalYear: parseInt(selectedYear),
      closingDate,
      retainedEarningsAccountId: retainedEarningsId,
      notes,
    });
    // Land on the closing journal entry when the workflow succeeds.
    navigate(`/finance/journal-entries/${result.closingEntryId}`);
  };

  const primary =
    step === "confirm" ? (
      <Button
        onClick={handleSubmit}
        disabled={isClosing || isYearAlreadyClosed}
        className="bg-destructive hover:bg-destructive/90"
      >
        {isClosing ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Processing…
          </>
        ) : (
          "Perform year-end closing"
        )}
      </Button>
    ) : (
      <Button
        onClick={handleNext}
        disabled={
          isYearAlreadyClosed ||
          (step === "scope" && !retainedEarningsId) ||
          (step === "preview" &&
            (isLoadingPreview ||
              closingPreview.incomeAccountsCount +
                closingPreview.expenseAccountsCount ===
                0))
        }
      >
        Continue
        <ArrowRight className="h-4 w-4 ml-2" />
      </Button>
    );

  return (
    <WizardShell
      header={
        <RecordHeader
          breadcrumb={
            <Link
              to="/finance/fiscal-periods"
              className="text-muted-foreground hover:text-foreground"
            >
              ← Back to fiscal periods
            </Link>
          }
          eyebrow="Finance"
          title="Year-end closing"
          docNumber={`FY ${selectedYear}`}
          meta={
            <span className="inline-flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              Close income &amp; expense accounts into Retained Earnings.
              {glPreview && (
                <Badge variant="outline" className="ml-2 text-[10px]">
                  GL-derived values
                </Badge>
              )}
            </span>
          }
        />
      }
      stepper={
        <WizardStepper
          steps={STEPS}
          activeStepId={step}
          completedStepIds={completedStepIds}
          onStepClick={handleStepClick}
        />
      }
      footer={
        <FooterActionBar
          anchor="page"
          leading={
            step !== "scope" ? (
              <Button variant="outline" onClick={handleBack} disabled={isClosing}>
                Back
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={() => navigate("/finance/fiscal-periods")}
              >
                Cancel
              </Button>
            )
          }
          trailing={<ActionBar>{primary}</ActionBar>}
        />
      }
    >
      {isYearAlreadyClosed && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Year already closed</AlertTitle>
          <AlertDescription>
            Fiscal Year {selectedYear} has already been closed.
            {fiscalYearPeriod?.locked_at &&
              ` Closed on ${format(new Date(fiscalYearPeriod.locked_at), "MMM d, yyyy")}.`}
          </AlertDescription>
        </Alert>
      )}

      {step === "scope" && (
        <Section title="Scope">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Fiscal year to close</Label>
              <Select value={selectedYear} onValueChange={setSelectedYear}>
                <SelectTrigger>
                  <SelectValue placeholder="Select fiscal year" />
                </SelectTrigger>
                <SelectContent>
                  {availableYears.map((year) => (
                    <SelectItem key={year} value={year.toString()}>
                      FY {year}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Retained earnings account</Label>
              {retainedEarningsAccounts.length === 0 ? (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    No Retained Earnings account found. Create an equity
                    account named "Retained Earnings" in your Chart of
                    Accounts first.
                  </AlertDescription>
                </Alert>
              ) : (
                <Select
                  value={retainedEarningsId}
                  onValueChange={setRetainedEarningsId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select retained earnings account" />
                  </SelectTrigger>
                  <SelectContent>
                    {retainedEarningsAccounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.code} - {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        </Section>
      )}

      {step === "preview" && (
        <Section title="Closing entry preview">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" /> Balances rolling into Retained Earnings
                {isLoadingPreview && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  <span className="font-medium">Total revenue</span>
                  <Badge variant="outline" className="ml-2">
                    {closingPreview.incomeAccountsCount} accounts
                  </Badge>
                </div>
                <span className="font-bold text-primary">
                  {closingPreview.totalIncome.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-destructive" />
                  <span className="font-medium">Total expenses</span>
                  <Badge variant="outline" className="ml-2">
                    {closingPreview.expenseAccountsCount} accounts
                  </Badge>
                </div>
                <span className="font-bold text-destructive">
                  ({closingPreview.totalExpenses.toLocaleString()})
                </span>
              </div>
              <Separator />
              <div
                className={`flex items-center justify-between p-4 rounded-lg ${
                  closingPreview.isProfit ? "bg-primary/5" : "bg-destructive/5"
                }`}
              >
                <div className="flex items-center gap-2">
                  {closingPreview.isProfit ? (
                    <CheckCircle2 className="h-5 w-5 text-primary" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-destructive" />
                  )}
                  <span className="font-semibold">
                    {closingPreview.isProfit ? "Net income" : "Net loss"}
                  </span>
                </div>
                <span
                  className={`text-xl font-bold ${
                    closingPreview.isProfit
                      ? "text-primary"
                      : "text-destructive"
                  }`}
                >
                  {closingPreview.isProfit ? "" : "("}
                  {Math.abs(closingPreview.netIncomeOrLoss).toLocaleString()}
                  {closingPreview.isProfit ? "" : ")"}
                </span>
              </div>
              <div className="flex items-center justify-center gap-2 text-muted-foreground">
                <ArrowRight className="h-4 w-4" />
                <span className="text-sm">
                  Will be transferred to Retained Earnings
                </span>
              </div>
            </CardContent>
          </Card>
        </Section>
      )}

      {step === "confirm" && (
        <Section title="Confirm year-end closing">
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>This action will</AlertTitle>
            <AlertDescription>
              <ul className="list-disc list-inside space-y-1 text-sm mt-2">
                <li>
                  Create a closing journal entry zeroing all income and
                  expense accounts
                </li>
                <li>
                  Transfer{" "}
                  {closingPreview.isProfit ? "net income" : "net loss"} of{" "}
                  {Math.abs(closingPreview.netIncomeOrLoss).toLocaleString()}{" "}
                  to Retained Earnings
                </li>
                <li>Close the fiscal year period (FY {selectedYear})</li>
                <li>
                  Close all open monthly periods for {selectedYear}
                </li>
              </ul>
              <p className="mt-2 font-medium">
                This action cannot be undone without manual reversing entries.
              </p>
            </AlertDescription>
          </Alert>
          <div className="space-y-2 mt-4">
            <Label htmlFor="ye-notes">Closing notes (optional)</Label>
            <Textarea
              id="ye-notes"
              placeholder="Add any notes about this year-end closing…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
        </Section>
      )}
    </WizardShell>
  );
}
