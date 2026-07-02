import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useAccounts } from "@/hooks/useAccounts";
import { useReconciliationSessions } from "@/hooks/useReconciliationSessions";
import { Loader2, Scale, ChevronDown, Info, PlayCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface StartReconciliationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (params: {
    bankAccountId: string;
    statementDate: string;
    openingBalance: number;
    closingBalance: number;
    serviceChargeAmount?: number;
    serviceChargeDate?: string;
    serviceChargeAccountId?: string;
    interestEarnedAmount?: number;
    interestEarnedDate?: string;
    interestEarnedAccountId?: string;
  }) => Promise<any>;
  preselectedAccountId?: string;
}

export function StartReconciliationDialog({
  open,
  onOpenChange,
  onStart,
  preselectedAccountId,
}: StartReconciliationDialogProps) {
  const { accounts: bankAccounts } = useBankAccounts();
  const { accounts: glAccounts } = useAccounts();
  const { sessions } = useReconciliationSessions();

  const [bankAccountId, setBankAccountId] = useState(preselectedAccountId || "");
  const [statementDate, setStatementDate] = useState(new Date().toISOString().split("T")[0]);
  const [openingBalance, setOpeningBalance] = useState("");
  const [closingBalance, setClosingBalance] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Service charge / Interest (collapsible section)
  const [showExtras, setShowExtras] = useState(false);
  const [serviceChargeAmount, setServiceChargeAmount] = useState("");
  const [serviceChargeDate, setServiceChargeDate] = useState("");
  const [serviceChargeAccountId, setServiceChargeAccountId] = useState("");
  const [interestEarnedAmount, setInterestEarnedAmount] = useState("");
  const [interestEarnedDate, setInterestEarnedDate] = useState("");
  const [interestEarnedAccountId, setInterestEarnedAccountId] = useState("");

  const activeAccounts = bankAccounts?.filter(a => a.is_active) || [];

  // R4 / G2 — block opening a second session and offer Resume instead.
  // The parent page auto-renders ReconciliationWorkspace from the hook's
  // activeSession state, so "Resume" just dismisses this dialog.
  const openSessionForAccount = bankAccountId
    ? sessions.find(s => s.bank_account_id === bankAccountId && s.status === "in_progress")
    : null;
  const hasOpenSession = !!openSessionForAccount;

  // Get the selected account to determine type-specific labels
  const selectedAccount = activeAccounts.find(a => a.id === bankAccountId);
  const isCreditCard = (selectedAccount as any)?.account_type === "credit_card";

  // Expense accounts for service charges; income accounts for interest
  const expenseAccounts = glAccounts?.filter(a => a.account_type === "expense" && a.is_active) || [];
  const incomeAccounts = glAccounts?.filter(a => a.account_type === "income" && a.is_active) || [];

  // Auto-populate opening balance from last completed session for this bank account
  useEffect(() => {
    if (bankAccountId && sessions.length > 0) {
      const lastCompleted = sessions.find(
        s => s.bank_account_id === bankAccountId && s.status === "completed"
      );
      if (lastCompleted) {
        setOpeningBalance(lastCompleted.closing_balance.toString());
      } else {
        // Use bank account's opening balance if no prior session
        const bankAcc = activeAccounts.find(a => a.id === bankAccountId);
        if (bankAcc) {
          setOpeningBalance((bankAcc as any).opening_balance?.toString() || "0");
        }
      }
    }
  }, [bankAccountId, sessions, activeAccounts]);

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setBankAccountId(preselectedAccountId || "");
      setClosingBalance("");
      setServiceChargeAmount("");
      setServiceChargeDate("");
      setServiceChargeAccountId("");
      setInterestEarnedAmount("");
      setInterestEarnedDate("");
      setInterestEarnedAccountId("");
      setShowExtras(false);
    }
  }, [open, preselectedAccountId]);

  const handleStart = async () => {
    if (!bankAccountId || !statementDate || closingBalance === "") return;
    setIsSubmitting(true);
    try {
      const result = await onStart({
        bankAccountId,
        statementDate,
        openingBalance: parseFloat(openingBalance) || 0,
        closingBalance: parseFloat(closingBalance) || 0,
        serviceChargeAmount: serviceChargeAmount ? parseFloat(serviceChargeAmount) : undefined,
        serviceChargeDate: serviceChargeDate || undefined,
        serviceChargeAccountId: serviceChargeAccountId || undefined,
        interestEarnedAmount: interestEarnedAmount ? parseFloat(interestEarnedAmount) : undefined,
        interestEarnedDate: interestEarnedDate || undefined,
        interestEarnedAccountId: interestEarnedAccountId || undefined,
      });
      if (result) {
        onOpenChange(false);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-start gap-2 text-left leading-snug">
            <Scale className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
            <span>
              {isCreditCard ? "Reconcile Credit Card Statement" : "Reconcile Bank Statement"}
            </span>
          </DialogTitle>
          <DialogDescription>
            Enter your {isCreditCard ? "credit card" : "bank"} statement details to begin reconciling.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 min-w-0">
          {/* Bank Account */}
          <div className="space-y-2 min-w-0">
            <Label>Account</Label>
            <Select value={bankAccountId} onValueChange={setBankAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Which account are you reconciling?" />
              </SelectTrigger>
              <SelectContent>
                {activeAccounts.map(acc => (
                  <SelectItem key={acc.id} value={acc.id}>
                    {acc.name} — {acc.bank_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {hasOpenSession && (
            <Alert>
              <PlayCircle className="h-4 w-4" />
              <AlertTitle>Reconciliation already in progress</AlertTitle>
              <AlertDescription>
                A reconciliation session for this account is open
                {openSessionForAccount?.statement_date
                  ? ` (statement date ${openSessionForAccount.statement_date})`
                  : ""}.
                Only one open session per bank account is allowed — resume the
                existing one before starting a new statement.
              </AlertDescription>
            </Alert>
          )}

          {/* Statement Details */}
          <div className="space-y-4 min-w-0">
            <h4 className="text-sm font-medium">Add the following information from your statement</h4>

            <div className="space-y-2">
              <Label>Statement Ending Date</Label>
              <Input
                type="date"
                value={statementDate}
                onChange={e => setStatementDate(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>Beginning Balance</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={openingBalance}
                onChange={e => setOpeningBalance(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Auto-populated from your last completed reconciliation
              </p>
            </div>

            <div className="space-y-2">
              <Label>{isCreditCard ? "Credit Card Statement Ending Balance" : "Statement Ending Balance"}</Label>
              <Input
                type="number"
                step="0.01"
                placeholder="0.00"
                value={closingBalance}
                onChange={e => setClosingBalance(e.target.value)}
              />
            </div>
          </div>

          <Separator />

          {/* Service Charge / Interest — Collapsible */}
          <Collapsible open={showExtras} onOpenChange={setShowExtras}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto w-full items-start justify-between gap-3 whitespace-normal px-0 py-2 text-left text-muted-foreground"
              >
                <span className="min-w-0 flex-1 leading-snug">
                  Enter service charge or interest earned (optional)
                </span>
                <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 transition-transform ${showExtras ? "rotate-180" : ""}`} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-2">
              {/* Service Charge */}
              <div className="space-y-3 rounded-lg border p-3">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Service Charge</h5>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Date</Label>
                    <Input
                      type="date"
                      value={serviceChargeDate}
                      onChange={e => setServiceChargeDate(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Amount</Label>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      value={serviceChargeAmount}
                      onChange={e => setServiceChargeAmount(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                <div className="space-y-1 min-w-0">
                  <Label className="text-xs">Account</Label>
                  <Select value={serviceChargeAccountId} onValueChange={setServiceChargeAccountId}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Select expense account" />
                    </SelectTrigger>
                    <SelectContent>
                      {expenseAccounts.map(a => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Interest Earned */}
              <div className="space-y-3 rounded-lg border p-3">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Interest Earned</h5>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Date</Label>
                    <Input
                      type="date"
                      value={interestEarnedDate}
                      onChange={e => setInterestEarnedDate(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Amount</Label>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      value={interestEarnedAmount}
                      onChange={e => setInterestEarnedAmount(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                <div className="space-y-1 min-w-0">
                  <Label className="text-xs">Account</Label>
                  <Select value={interestEarnedAccountId} onValueChange={setInterestEarnedAccountId}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Select income account" />
                    </SelectTrigger>
                    <SelectContent>
                      {incomeAccounts.map(a => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="flex min-w-0 items-start gap-2 rounded-lg border bg-muted/50 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              You'll see all transactions up to the statement date. Check off cleared items until 
              the difference reaches $0.00, then click Finish to complete reconciliation.
            </p>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting} className="w-full sm:w-auto">
            Cancel
          </Button>
          {hasOpenSession ? (
            <Button
              onClick={() => onOpenChange(false)}
              className="w-full sm:w-auto"
            >
              <PlayCircle className="mr-2 h-4 w-4" />
              Resume reconciliation
            </Button>
          ) : (
            <Button
              onClick={handleStart}
              disabled={isSubmitting || !bankAccountId || closingBalance === ""}
              className="w-full sm:w-auto"
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Start Reconciling
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
