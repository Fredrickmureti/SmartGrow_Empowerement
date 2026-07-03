/**
 * StartReconciliationPage — full-page start form at
 * `/finance/reconciliation/new`. Replaces the legacy
 * `StartReconciliationDialog` (deleted) with a `RecordFormShell` surface
 * consistent with every other Finance create route.
 *
 * The page reads the (optional) `?account=<uuid>` query param to
 * preselect a bank account. On successful `startSession(...)` it
 * navigates back to `/finance/reconciliation?account=<id>` where the
 * reconciliation workspace auto-mounts from `activeSession`.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  RecordFormShell,
  Section,
  useRecordFormSubmit,
} from "@/design-system";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { ChevronDown, PlayCircle } from "lucide-react";

export default function StartReconciliationPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselectedAccountId = searchParams.get("account") ?? "";

  const { accounts: bankAccounts } = useBankAccounts();
  const { accounts: glAccounts } = useAccounts();
  const { sessions, startSession } = useReconciliationSessions(
    preselectedAccountId || undefined,
  );

  const [bankAccountId, setBankAccountId] = useState(preselectedAccountId);
  const [statementDate, setStatementDate] = useState(
    new Date().toISOString().split("T")[0],
  );
  const [openingBalance, setOpeningBalance] = useState("");
  const [closingBalance, setClosingBalance] = useState("");

  const [showExtras, setShowExtras] = useState(false);
  const [serviceChargeAmount, setServiceChargeAmount] = useState("");
  const [serviceChargeDate, setServiceChargeDate] = useState("");
  const [serviceChargeAccountId, setServiceChargeAccountId] = useState("");
  const [interestEarnedAmount, setInterestEarnedAmount] = useState("");
  const [interestEarnedDate, setInterestEarnedDate] = useState("");
  const [interestEarnedAccountId, setInterestEarnedAccountId] = useState("");

  const activeAccounts = useMemo(
    () => (bankAccounts ?? []).filter((a) => a.is_active),
    [bankAccounts],
  );
  const openSessionForAccount = bankAccountId
    ? sessions.find(
        (s) => s.bank_account_id === bankAccountId && s.status === "in_progress",
      )
    : null;
  const hasOpenSession = !!openSessionForAccount;

  const selectedAccount = activeAccounts.find((a) => a.id === bankAccountId);
  const isCreditCard =
    (selectedAccount as { account_type?: string } | undefined)?.account_type ===
    "credit_card";

  const expenseAccounts = useMemo(
    () =>
      (glAccounts ?? []).filter(
        (a) => a.account_type === "expense" && a.is_active,
      ),
    [glAccounts],
  );
  const incomeAccounts = useMemo(
    () =>
      (glAccounts ?? []).filter(
        (a) => a.account_type === "income" && a.is_active,
      ),
    [glAccounts],
  );

  // Auto-populate opening balance from the last completed session, or fall
  // back to the bank account's opening balance.
  useEffect(() => {
    if (!bankAccountId) return;
    const lastCompleted = sessions.find(
      (s) => s.bank_account_id === bankAccountId && s.status === "completed",
    );
    if (lastCompleted) {
      setOpeningBalance(String(lastCompleted.closing_balance));
      return;
    }
    const bankAcc = activeAccounts.find((a) => a.id === bankAccountId) as
      | { opening_balance?: number | null }
      | undefined;
    setOpeningBalance(String(bankAcc?.opening_balance ?? 0));
  }, [bankAccountId, sessions, activeAccounts]);

  const submit = useRecordFormSubmit<unknown>({
    entityLabel: "Reconciliation",
    mode: "create",
    successTitle: "Reconciliation started",
    redirectTo: () =>
      `/finance/reconciliation${bankAccountId ? `?account=${bankAccountId}` : ""}`,
  });

  const canSubmit =
    !!bankAccountId && !!statementDate && closingBalance !== "" && !hasOpenSession;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) return;
    submit.run(() =>
      startSession({
        bankAccountId,
        statementDate,
        openingBalance: parseFloat(openingBalance) || 0,
        closingBalance: parseFloat(closingBalance) || 0,
        serviceChargeAmount: serviceChargeAmount
          ? parseFloat(serviceChargeAmount)
          : undefined,
        serviceChargeDate: serviceChargeDate || undefined,
        serviceChargeAccountId: serviceChargeAccountId || undefined,
        interestEarnedAmount: interestEarnedAmount
          ? parseFloat(interestEarnedAmount)
          : undefined,
        interestEarnedDate: interestEarnedDate || undefined,
        interestEarnedAccountId: interestEarnedAccountId || undefined,
      }),
    );
  };

  const cancelHref = `/finance/reconciliation${
    preselectedAccountId ? `?account=${preselectedAccountId}` : ""
  }`;

  return (
    <RecordFormShell
      mode="create"
      entityLabel={isCreditCard ? "Credit Card Reconciliation" : "Bank Reconciliation"}
      cancelHref={cancelHref}
      onCancel={() => navigate(cancelHref)}
      onSubmit={onSubmit}
      isSubmitting={submit.isSubmitting}
      submitLabel="Start reconciling"
      submitDisabled={!canSubmit}
    >
      <Section
        title="Statement"
        description="Enter the details from the statement you are reconciling against."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <Label>Account</Label>
            <Select value={bankAccountId} onValueChange={setBankAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Which account are you reconciling?" />
              </SelectTrigger>
              <SelectContent>
                {activeAccounts.map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    {acc.name} — {acc.bank_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Statement ending date</Label>
            <Input
              type="date"
              value={statementDate}
              onChange={(e) => setStatementDate(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Beginning balance</Label>
            <Input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={openingBalance}
              onChange={(e) => setOpeningBalance(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Auto-populated from your last completed reconciliation.
            </p>
          </div>

          <div className="space-y-2">
            <Label>
              {isCreditCard
                ? "Credit card statement ending balance"
                : "Statement ending balance"}
            </Label>
            <Input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={closingBalance}
              onChange={(e) => setClosingBalance(e.target.value)}
            />
          </div>
        </div>

        {hasOpenSession && (
          <Alert className="mt-4">
            <PlayCircle className="h-4 w-4" />
            <AlertTitle>Reconciliation already in progress</AlertTitle>
            <AlertDescription>
              A reconciliation session for this account is open
              {openSessionForAccount?.statement_date
                ? ` (statement date ${openSessionForAccount.statement_date})`
                : ""}
              . Only one open session per bank account is allowed — resume
              the existing one before starting a new statement.
              <div className="mt-3">
                <Button size="sm" onClick={() => navigate(cancelHref)}>
                  <PlayCircle className="mr-2 h-4 w-4" />
                  Resume reconciliation
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </Section>

      <Section title="Adjustments" description="Optional service charges or interest earned to post as part of this statement.">
        <Collapsible open={showExtras} onOpenChange={setShowExtras}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto w-full items-center justify-between gap-3 px-0 py-2 text-left text-muted-foreground"
            >
              <span>Enter service charge or interest earned (optional)</span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 transition-transform ${
                  showExtras ? "rotate-180" : ""
                }`}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-2">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-3 rounded-lg border p-3">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Service charge
                </h5>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Date</Label>
                    <Input
                      type="date"
                      value={serviceChargeDate}
                      onChange={(e) => setServiceChargeDate(e.target.value)}
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
                      onChange={(e) => setServiceChargeAmount(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Account</Label>
                  <Select
                    value={serviceChargeAccountId}
                    onValueChange={setServiceChargeAccountId}
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Select expense account" />
                    </SelectTrigger>
                    <SelectContent>
                      {expenseAccounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border p-3">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Interest earned
                </h5>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Date</Label>
                    <Input
                      type="date"
                      value={interestEarnedDate}
                      onChange={(e) => setInterestEarnedDate(e.target.value)}
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
                      onChange={(e) => setInterestEarnedAmount(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Account</Label>
                  <Select
                    value={interestEarnedAccountId}
                    onValueChange={setInterestEarnedAccountId}
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Select income account" />
                    </SelectTrigger>
                    <SelectContent>
                      {incomeAccounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Section>
    </RecordFormShell>
  );
}
