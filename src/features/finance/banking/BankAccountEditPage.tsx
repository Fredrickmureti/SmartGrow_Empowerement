/**
 * BankAccountEditPage — full-page `/finance/banking/accounts/:id/edit`
 * route replacement for `BankAccountSheet` in edit mode.
 *
 * Same fields, same currency-lock guard on posted-history accounts, same
 * branch re-attribution confirmation, same is_shared ⇔ branch_id === null
 * invariant. Composed on `RecordFormShell` so the interaction language
 * matches every other Finance edit surface.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Lock, AlertTriangle } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useBankAccounts, type BankAccount } from "@/hooks/useBankAccounts";
import { useAccounts } from "@/hooks/useAccounts";
import { useBranch } from "@/contexts/BranchContext";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { CurrencyCombobox } from "@/components/contacts/CurrencyCombobox";
import { useBusinessActiveCurrencies } from "@/hooks/useBusinessActiveCurrencies";

import {
  BANK_ACCOUNT_TYPES,
  filterGLAccountsForBankType,
  fallbackGLAccountsForBankType,
} from "@/lib/bankAccountTypes";

import {
  ErrorState,
  FieldCell,
  FieldGrid,
  LoadingState,
  RecordFormShell,
  Section,
  useRecordFormSubmit,
} from "@/design-system";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export default function BankAccountEditPage() {
  const { id: accountId = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { accounts: bankAccounts, updateAccount, transitionAccount } =
    useBankAccounts();

  const { accounts: glAccounts, isLoading: glLoading } = useAccounts();
  const scope = useFinanceScope();
  const { branches } = useBranch();

  const account = useMemo<BankAccount | null>(
    () => bankAccounts?.find((a) => a.id === accountId) ?? null,
    [bankAccounts, accountId],
  );

  const [name, setName] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [currency, setCurrency] = useState("");
  const { currencies: activeCurrencies, isLoading: currenciesLoading } =
    useBusinessActiveCurrencies();

  const [accountType, setAccountType] = useState("checking");
  const [glAccountId, setGlAccountId] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [isPrimary, setIsPrimary] = useState(false);
  const [hasTransactions, setHasTransactions] = useState(false);
  const [checkingTxns, setCheckingTxns] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const branchSelectorLocked =
    !scope.isHeadquartersContext && !scope.isConsolidated;
  const [branchScope, setBranchScope] = useState<string>("__all__");
  const [reattributeConfirmed, setReattributeConfirmed] = useState(false);

  const strictGL = filterGLAccountsForBankType(glAccounts || [], accountType);
  const usedFallback = strictGL.length === 0;
  const bankGLAccounts = usedFallback
    ? fallbackGLAccountsForBankType(glAccounts || [], accountType)
    : strictGL;
  const linkedGL = glAccountId
    ? (glAccounts || []).find((a) => a.id === glAccountId)
    : null;
  const dropdownGL =
    linkedGL && !bankGLAccounts.some((a) => a.id === linkedGL.id)
      ? [linkedGL, ...bankGLAccounts]
      : bankGLAccounts;

  useEffect(() => {
    if (!account || hydrated) return;
    setName(account.name || "");
    setBankName(account.bank_name || "");
    setAccountNumber(account.account_number || "");
    setCurrency(account.currency || "");
    setAccountType((account as any).account_type || "checking");
    setGlAccountId(account.account_id || "");
    setIsActive(account.is_active ?? true);
    setIsPrimary(account.is_primary ?? false);
    setBranchScope(account.branch_id ?? "__all__");
    setReattributeConfirmed(false);
    setHydrated(true);
  }, [account, hydrated]);

  const originalBranchScope = account?.branch_id ?? "__all__";
  const branchChanged = branchScope !== originalBranchScope;
  const requiresReattributeConfirm = branchChanged && hasTransactions;

  useEffect(() => {
    if (!account) return;
    setCheckingTxns(true);
    (async () => {
      const [{ count: txCount }, jeProbe] = await Promise.all([
        supabase
          .from("bank_transactions")
          .select("id", { count: "exact", head: true })
          .eq("bank_account_id", account.id),
        account.account_id
          ? supabase
              .from("journal_entry_lines")
              .select("id", { count: "exact", head: true })
              .eq("account_id", account.account_id)
          : Promise.resolve({ count: 0 } as { count: number | null }),
      ]);
      const jeCount = (jeProbe as { count: number | null }).count ?? 0;
      setHasTransactions((txCount ?? 0) > 0 || jeCount > 0);
      setCheckingTxns(false);
    })();
  }, [account]);

  const submit = useRecordFormSubmit<BankAccount | void>({
    entityLabel: "Bank account",
    mode: "edit",
    redirectTo: () => "/finance/banking",
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!account || !name.trim()) return;
    if (isActive && !glAccountId) return;
    if (requiresReattributeConfirm && !reattributeConfirmed) return;
    const resolvedBranchId = branchScope === "__all__" ? null : branchScope;
    const statusChanged = isActive !== (account.lifecycle_status === "active");
    submit.run(async () => {
      await updateAccount(
        account.id,
        {
          name: name.trim(),
          bank_name: bankName.trim() || undefined,
          account_number: accountNumber.trim() || undefined,
          currency: hasTransactions ? undefined : currency.toUpperCase(),
          account_type: accountType,
          account_id: glAccountId || null,
          is_primary: isPrimary,
          ...(branchChanged ? { branch_id: resolvedBranchId } : {}),
        },
        account.row_version,
      );
      // Active/inactive is a lifecycle transition, not a field write.
      if (statusChanged) {
        await transitionAccount(account.id, isActive ? "active" : "suspended");
      }
    });
  };


  if (!account) {
    return bankAccounts === undefined || (bankAccounts?.length ?? 0) === 0 ? (
      <LoadingState />
    ) : (
      <ErrorState
        title="Bank account not found"
        description="This account may have been deleted or you don't have access."
        onRetry={() => navigate("/finance/banking")}
      />
    );
  }

  const submitDisabled =
    !name.trim() ||
    (isActive && !glAccountId) ||
    !currency.trim() ||
    (requiresReattributeConfirm && !reattributeConfirmed);

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Bank account"
      recordRef={account.name}
      cancelHref="/finance/banking"
      onSubmit={onSubmit}
      isSubmitting={submit.isSubmitting}
      submitDisabled={submitDisabled}
      submitLabel="Save changes"
    >
      <Section title="Account details">
        <FieldGrid columns={2}>
          <FieldCell span="full">
            <Label>Account name *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Main business account"
              className="mt-1.5"
            />
          </FieldCell>

          <FieldCell>
            <Label>Bank name</Label>
            <Input
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              placeholder="e.g., Equity Bank"
              className="mt-1.5"
            />
          </FieldCell>

          <FieldCell>
            <Label>Account number</Label>
            <Input
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              placeholder="Enter account number"
              className="mt-1.5"
            />
          </FieldCell>

          <FieldCell>
            <Label className="flex items-center gap-1">
              Currency
              {hasTransactions && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Lock className="h-3 w-3 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    Locked: this account has posted history. Changing the
                    currency would silently re-value the books.
                  </TooltipContent>
                </Tooltip>
              )}
            </Label>
            <div className="mt-1.5">
              {/* Active-currency list only; the seam validates the same set. */}
              <CurrencyCombobox
                currencies={activeCurrencies}
                value={currency}
                onValueChange={setCurrency}
                placeholder={
                  currenciesLoading ? "Loading currencies…" : "Select currency..."
                }
                disabled={hasTransactions || checkingTxns || currenciesLoading}
              />
            </div>

          </FieldCell>

          <FieldCell>
            <Label>Account type</Label>
            <Select value={accountType} onValueChange={setAccountType}>
              <SelectTrigger className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BANK_ACCOUNT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldCell>
        </FieldGrid>
      </Section>

      <Section title="GL link">
        <FieldGrid columns={2}>
          <FieldCell span="full">
            <Label className="flex items-center gap-1">
              Link to GL account
              {isActive && <span className="text-destructive">*</span>}
            </Label>
            <Select
              value={glAccountId || "__none__"}
              onValueChange={(v) => setGlAccountId(v === "__none__" ? "" : v)}
              disabled={glLoading}
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue
                  placeholder={glLoading ? "Loading GL accounts…" : "Select a GL account"}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None (inactive only)</SelectItem>
                {dropdownGL.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} — {a.name}
                    {linkedGL?.id === a.id &&
                    a.account_type !== bankGLAccounts[0]?.account_type
                      ? " (current link, type mismatch)"
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Required for active accounts. Drives balance derivation,
              reconciliation postings, and report classification.{" "}
              <Link
                to="/finance/chart-of-accounts"
                target="_blank"
                rel="noopener"
                className="underline"
              >
                + Create new GL account
              </Link>
            </p>
            {!glLoading && usedFallback && bankGLAccounts.length > 0 && (
              <p className="mt-1 text-xs text-amber-600">
                No GL accounts are explicitly tagged for this bank type.
                Showing all active {bankGLAccounts[0]?.account_type} accounts.
                For better filtering, set the Detail Type on your bank/cash GL
                accounts.
              </p>
            )}
            {!glLoading && bankGLAccounts.length === 0 && (
              <p className="mt-1 text-xs text-amber-600">
                No active{" "}
                {accountType === "credit_card" || accountType === "loan"
                  ? "liability"
                  : "asset"}{" "}
                GL accounts found.{" "}
                <Link
                  to="/finance/chart-of-accounts"
                  target="_blank"
                  rel="noopener"
                  className="underline"
                >
                  Create one in Chart of Accounts
                </Link>
                , then return here.
              </p>
            )}
            {isActive && !glAccountId && (
              <p className="mt-1 text-xs text-destructive">
                A GL link is required to keep this account active.
              </p>
            )}
          </FieldCell>
        </FieldGrid>
      </Section>

      <Section title="Status">
        <FieldGrid columns={2}>
          <FieldCell>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="text-sm">Primary account</Label>
                <p className="text-xs text-muted-foreground">Default bank account</p>
              </div>
              <Switch checked={isPrimary} onCheckedChange={setIsPrimary} />
            </div>
          </FieldCell>

          <FieldCell>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label className="text-sm">Active</Label>
                <p className="text-xs text-muted-foreground">
                  Inactive accounts are hidden from selections
                </p>
              </div>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </div>
          </FieldCell>
        </FieldGrid>
      </Section>

      <Section title="Branch scope">
        <FieldGrid columns={2}>
          <FieldCell span="full">
            <Label className="flex items-center gap-1">
              Branch scope
              {branchSelectorLocked && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Lock className="h-3 w-3 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    Branch users can only manage accounts attached to their own
                    branch. Switch to the HQ branch to re-attribute.
                  </TooltipContent>
                </Tooltip>
              )}
            </Label>
            <Select
              value={branchScope}
              onValueChange={setBranchScope}
              disabled={branchSelectorLocked}
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Shared across all branches</SelectItem>
                {(branches || []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                    {b.is_headquarters ? " (HQ)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Bank credentials and GL link belong to the business. Branch is an
              analytic tag stamped on every transaction from this account.
            </p>
            {requiresReattributeConfirm && (
              <Alert variant="destructive" className="mt-3">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>This will re-attribute existing history</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>
                    Posted bank transactions and reconciliation sessions for
                    this account will be re-stamped to the new branch scope.
                    Branch P&amp;L and consolidated reports will shift
                    accordingly.
                  </p>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={reattributeConfirmed}
                      onCheckedChange={(v) =>
                        setReattributeConfirmed(v === true)
                      }
                    />
                    <span>I understand and want to re-attribute history</span>
                  </label>
                </AlertDescription>
              </Alert>
            )}
          </FieldCell>
        </FieldGrid>
      </Section>
    </RecordFormShell>
  );
}
