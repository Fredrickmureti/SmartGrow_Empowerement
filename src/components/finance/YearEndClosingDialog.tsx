import { useState, useEffect } from "react";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useYearEndClosing } from "@/hooks/useYearEndClosing";
import { useFiscalPeriods } from "@/hooks/useFiscalPeriods";
import {
  Loader2, AlertTriangle, CheckCircle2, TrendingUp, TrendingDown,
  Calendar, FileText, ArrowRight,
} from "lucide-react";
import { format, endOfYear } from "date-fns";

interface YearEndClosingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function YearEndClosingDialog({ open, onOpenChange, onSuccess }: YearEndClosingDialogProps) {
  const { periods } = useFiscalPeriods();
  const {
    incomeAccounts, expenseAccounts, retainedEarningsAccounts,
    calculateClosingTotals, getQuickPreview,
    performYearEndClosing, isClosing,
  } = useYearEndClosing();

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState((currentYear - 1).toString());
  const [retainedEarningsId, setRetainedEarningsId] = useState("");
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<"preview" | "confirm">("preview");
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [glPreview, setGlPreview] = useState<ReturnType<typeof getQuickPreview> | null>(null);

  const availableYears = Array.from({ length: 5 }, (_, i) => currentYear - 1 - i);

  // Use GL-derived preview when dialog opens or year changes
  useEffect(() => {
    if (open && selectedYear) {
      setIsLoadingPreview(true);
      calculateClosingTotals(parseInt(selectedYear))
        .then(result => setGlPreview(result))
        .catch(() => setGlPreview(getQuickPreview()))
        .finally(() => setIsLoadingPreview(false));
    }
  }, [open, selectedYear]);

  const closingPreview = glPreview || getQuickPreview();

  const fiscalYearPeriod = periods.find(p =>
    p.period_type === "year" && p.name.includes(selectedYear)
  );
  const isYearAlreadyClosed = fiscalYearPeriod?.status === "closed";

  useEffect(() => {
    if (retainedEarningsAccounts.length > 0 && !retainedEarningsId) {
      setRetainedEarningsId(retainedEarningsAccounts[0].id);
    }
  }, [retainedEarningsAccounts, retainedEarningsId]);

  const handleClose = () => {
    setStep("preview");
    setNotes("");
    setGlPreview(null);
    onOpenChange(false);
  };

  const handlePerformClosing = async () => {
    if (!retainedEarningsId) return;
    const closingDate = format(endOfYear(new Date(parseInt(selectedYear), 0, 1)), "yyyy-MM-dd");
    await performYearEndClosing.mutateAsync({
      fiscalYear: parseInt(selectedYear),
      closingDate,
      retainedEarningsAccountId: retainedEarningsId,
      notes,
    });
    handleClose();
    onSuccess?.();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[720px] max-h-[90vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" /> Year-End Closing Process
          </SheetTitle>
          <SheetDescription>
            Close the fiscal year by transferring income and expense balances to Retained Earnings.
            {glPreview && <Badge variant="outline" className="ml-2 text-[10px]">GL-derived values</Badge>}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6">
          <div className="space-y-2">
            <Label>Fiscal Year to Close</Label>
            <Select value={selectedYear} onValueChange={setSelectedYear}>
              <SelectTrigger><SelectValue placeholder="Select fiscal year" /></SelectTrigger>
              <SelectContent>
                {availableYears.map(year => (
                  <SelectItem key={year} value={year.toString()}>FY {year}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isYearAlreadyClosed && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Year Already Closed</AlertTitle>
              <AlertDescription>
                Fiscal Year {selectedYear} has already been closed.
                {fiscalYearPeriod?.locked_at && ` Closed on ${format(new Date(fiscalYearPeriod.locked_at), "MMM d, yyyy")}.`}
              </AlertDescription>
            </Alert>
          )}

          {!isYearAlreadyClosed && (
            <>
              {step === "preview" && (
                <>
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <FileText className="h-4 w-4" /> Closing Entry Preview
                        {isLoadingPreview && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                        <div className="flex items-center gap-2">
                          <TrendingUp className="h-4 w-4 text-primary" />
                          <span className="font-medium">Total Revenue</span>
                          <Badge variant="outline" className="ml-2">{closingPreview.incomeAccountsCount} accounts</Badge>
                        </div>
                        <span className="font-bold text-primary">{closingPreview.totalIncome.toLocaleString()}</span>
                      </div>
                      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                        <div className="flex items-center gap-2">
                          <TrendingDown className="h-4 w-4 text-destructive" />
                          <span className="font-medium">Total Expenses</span>
                          <Badge variant="outline" className="ml-2">{closingPreview.expenseAccountsCount} accounts</Badge>
                        </div>
                        <span className="font-bold text-destructive">({closingPreview.totalExpenses.toLocaleString()})</span>
                      </div>
                      <Separator />
                      <div className={`flex items-center justify-between p-4 rounded-lg ${closingPreview.isProfit ? "bg-primary/5" : "bg-destructive/5"}`}>
                        <div className="flex items-center gap-2">
                          {closingPreview.isProfit ? <CheckCircle2 className="h-5 w-5 text-primary" /> : <AlertTriangle className="h-5 w-5 text-destructive" />}
                          <span className="font-semibold">{closingPreview.isProfit ? "Net Income" : "Net Loss"}</span>
                        </div>
                        <span className={`text-xl font-bold ${closingPreview.isProfit ? "text-primary" : "text-destructive"}`}>
                          {closingPreview.isProfit ? "" : "("}
                          {Math.abs(closingPreview.netIncomeOrLoss).toLocaleString()}
                          {closingPreview.isProfit ? "" : ")"}
                        </span>
                      </div>
                      <div className="flex items-center justify-center gap-2 text-muted-foreground">
                        <ArrowRight className="h-4 w-4" />
                        <span className="text-sm">Will be transferred to Retained Earnings</span>
                      </div>
                    </CardContent>
                  </Card>

                  <div className="space-y-2">
                    <Label>Retained Earnings Account</Label>
                    {retainedEarningsAccounts.length === 0 ? (
                      <Alert variant="destructive">
                        <AlertTriangle className="h-4 w-4" />
                        <AlertDescription>
                          No Retained Earnings account found. Please create an equity account named "Retained Earnings" in your Chart of Accounts first.
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <Select value={retainedEarningsId} onValueChange={setRetainedEarningsId}>
                        <SelectTrigger><SelectValue placeholder="Select retained earnings account" /></SelectTrigger>
                        <SelectContent>
                          {retainedEarningsAccounts.map(account => (
                            <SelectItem key={account.id} value={account.id}>{account.code} - {account.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </>
              )}

              {step === "confirm" && (
                <>
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>Confirm Year-End Closing</AlertTitle>
                    <AlertDescription>
                      <p className="mb-2">This action will:</p>
                      <ul className="list-disc list-inside space-y-1 text-sm">
                        <li>Create a closing journal entry zeroing all income and expense accounts</li>
                        <li>Transfer {closingPreview.isProfit ? "net income" : "net loss"} of {Math.abs(closingPreview.netIncomeOrLoss).toLocaleString()} to Retained Earnings</li>
                        <li>Close the fiscal year period (FY {selectedYear})</li>
                        <li>Close all open monthly periods for {selectedYear}</li>
                      </ul>
                      <p className="mt-2 font-medium">This action cannot be undone without manual reversing entries.</p>
                    </AlertDescription>
                  </Alert>
                  <div className="space-y-2">
                    <Label htmlFor="notes">Closing Notes (Optional)</Label>
                    <Textarea id="notes" placeholder="Add any notes about this year-end closing..." value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <SheetFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={isClosing}>Cancel</Button>
          {!isYearAlreadyClosed && step === "preview" && (
            <Button onClick={() => setStep("confirm")} disabled={!retainedEarningsId || closingPreview.incomeAccountsCount + closingPreview.expenseAccountsCount === 0 || isLoadingPreview}>
              Continue to Confirmation
            </Button>
          )}
          {!isYearAlreadyClosed && step === "confirm" && (
            <>
              <Button variant="outline" onClick={() => setStep("preview")} disabled={isClosing}>Back</Button>
              <Button onClick={handlePerformClosing} disabled={isClosing} className="bg-destructive hover:bg-destructive/90">
                {isClosing ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Processing...</>) : "Perform Year-End Closing"}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
