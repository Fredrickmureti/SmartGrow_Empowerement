/**
 * BankAccountCreatePage — full-page `/finance/banking/accounts/new` route
 * replacement for `BankAccountSheet` in connect mode.
 *
 * Preserves the two-step provider-picker → details flow, the Jenga
 * sandbox affordance, the atomic opening-balance JE post, and the branch
 * scope invariants. Composed on `RecordFormShell` for step 2 (details).
 * Step 1 (provider picker) is a slim standalone page that navigates
 * back to /finance/banking on Cancel.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Loader2,
  Lock,
  Building2,
  Upload,
  CheckCircle2,
  TestTube,
  Info,
  ChevronLeft,
  X,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useAccounts } from "@/hooks/useAccounts";
import { useBankProviders, type BankProvider } from "@/hooks/useBankProviders";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import {
  BANK_ACCOUNT_TYPES,
  filterGLAccountsForBankType,
  fallbackGLAccountsForBankType,
} from "@/lib/bankAccountTypes";

import {
  FieldCell,
  FieldGrid,
  RecordFormShell,
  Section,
  useRecordFormSubmit,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const JENGA_TEST_ACCOUNTS = [
  { label: "Equity Kenya Test 1", accountNumber: "1100194977404", bankCode: "68", currency: "KES", country: "KE" },
  { label: "Equity Kenya Test 2", accountNumber: "0020100014605", bankCode: "68", currency: "KES", country: "KE" },
  { label: "Equity Kenya Test 3", accountNumber: "1450160649886", bankCode: "68", currency: "KES", country: "KE" },
  { label: "Equity Kenya USD", accountNumber: "0810178838044", bankCode: "68", currency: "USD", country: "KE" },
];

const MANUAL_PROVIDER_OPTION = {
  id: "__manual__",
  provider_code: "manual",
  provider_name: "Manual / Import",
  description: "Add a bank account manually and import statements via CSV",
  logo_url: null,
  is_enabled: true,
  is_sandbox: false,
  supported_countries: [],
  api_base_url: null,
  api_key_encrypted: null,
  api_secret_encrypted: null,
  merchant_code: null,
  public_key: null,
  private_key_encrypted: null,
  config: null,
  created_at: "",
  updated_at: "",
} as BankProvider;

export default function BankAccountCreatePage() {
  const navigate = useNavigate();
  const { providers, isLoading: loadingProviders } = useBankProviders();
  const { createAccount } = useBankAccounts();
  const { accounts: glAccounts, isLoading: glLoading } = useAccounts();
  const { currentBusiness } = useBusinesses();
  const { branches } = useBranch();
  const scope = useFinanceScope();

  const [step, setStep] = useState<1 | 2>(1);
  const [selectedProvider, setSelectedProvider] = useState<BankProvider | null>(null);
  const [useTestAccount, setUseTestAccount] = useState(false);
  const [selectedTestAccount, setSelectedTestAccount] = useState<string>("");

  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [currency, setCurrency] = useState(currentBusiness?.base_currency ?? "");
  const [openingBalance, setOpeningBalance] = useState("");
  const [openingBalanceDate, setOpeningBalanceDate] = useState(
    new Date().toISOString().split("T")[0],
  );
  const [accountType, setAccountType] = useState("checking");
  const [glAccountId, setGlAccountId] = useState("");

  const branchSelectorLocked = !scope.isHeadquartersContext && !scope.isConsolidated;
  const [branchScope, setBranchScope] = useState<string>(
    branchSelectorLocked && scope.branchId ? scope.branchId : "__all__",
  );

  const allProviders = useMemo(() => {
    const live = providers.filter((p) => p.is_enabled && p.provider_code !== "manual");
    return [MANUAL_PROVIDER_OPTION, ...live];
  }, [providers]);

  const isJengaProvider =
    selectedProvider?.provider_code === "jenga" && selectedProvider?.is_sandbox;
  const isManualProvider = selectedProvider?.provider_code === "manual";

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
    if (selectedTestAccount && useTestAccount) {
      const testAcc = JENGA_TEST_ACCOUNTS.find(
        (a) => a.accountNumber === selectedTestAccount,
      );
      if (testAcc) {
        setAccountNumber(testAcc.accountNumber);
        setCurrency(testAcc.currency);
        setAccountName(testAcc.label);
        setBankName("Equity Bank");
      }
    }
  }, [selectedTestAccount, useTestAccount]);

  const handleSelectProvider = (provider: BankProvider) => {
    setSelectedProvider(provider);
    if (provider.provider_code !== "manual") {
      setBankName(
        provider.provider_name.replace(" API", "").replace(" (Equity Bank)", ""),
      );
    }
    if (provider.provider_code === "jenga" && provider.is_sandbox) {
      setUseTestAccount(true);
    }
    setStep(2);
  };

  const submit = useRecordFormSubmit<any>({
    entityLabel: "Bank account",
    mode: "create",
    redirectTo: () => "/finance/banking",
  });

  const runConnect = async () => {
    if (!selectedProvider) return;
    const resolvedBranchId = branchScope === "__all__" ? null : branchScope;
    // Single server call: the `bank_account_create` RPC stamps scope, validates
    // the currency against the company's active currencies and — in the same
    // transaction — posts the opening-balance journal entry through
    // `post_journal_entry_atomic`. The browser no longer orchestrates the GL.
    const newAccount = await createAccount({
      name: accountName,
      bank_name: bankName,
      account_number: accountNumber,
      currency,
      opening_balance: openingBalance ? parseFloat(openingBalance) : 0,
      opening_balance_date: isManualProvider ? openingBalanceDate : undefined,
      account_type: accountType,
      account_id: glAccountId || undefined,
      provider_id:
        selectedProvider.provider_code !== "manual" &&
        selectedProvider.id !== "__manual__"
          ? selectedProvider.id
          : undefined,
      external_account_id: accountNumber || undefined,
      branch_id: resolvedBranchId,
    });
    return newAccount;
  };


  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitDisabled) return;
    submit.run(runConnect);
  };

  const renderProviderIcon = (provider: BankProvider) => {
    if (provider.provider_code === "manual") return <Upload className="h-5 w-5" />;
    if (provider.logo_url) {
      return (
        <img
          src={provider.logo_url}
          alt={provider.provider_name}
          className="h-8 w-8 object-contain"
          onError={(e) => {
            e.currentTarget.style.display = "none";
            const fallback = e.currentTarget.nextElementSibling as HTMLElement;
            if (fallback) fallback.style.display = "block";
          }}
        />
      );
    }
    return <Building2 className="h-5 w-5" />;
  };

  const submitDisabled =
    !accountName ||
    !glAccountId ||
    !currency.trim() ||
    (isJengaProvider && !selectedTestAccount);

  /* ---------- Step 1: provider picker ------------------------------- */
  if (step === 1) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Add bank account
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a manual bank account or connect a live integration.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/finance/banking")}
          >
            <X className="mr-1 h-4 w-4" />
            Cancel
          </Button>
        </div>
        {loadingProviders ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <RadioGroup className="space-y-3">
            {allProviders.map((provider) => (
              <div
                key={provider.id}
                className="flex cursor-pointer items-center space-x-4 rounded-lg border p-4 transition-colors hover:bg-muted/50"
                onClick={() => handleSelectProvider(provider)}
              >
                <RadioGroupItem value={provider.id} id={provider.id} />
                <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg bg-muted">
                  {renderProviderIcon(provider)}
                  {provider.logo_url && provider.provider_code !== "manual" && (
                    <Building2 className="hidden h-5 w-5" />
                  )}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor={provider.id}
                      className="cursor-pointer font-medium"
                    >
                      {provider.provider_name}
                    </Label>
                    {provider.is_sandbox && (
                      <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600">
                        <TestTube className="h-3 w-3" />
                        Sandbox
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {provider.description}
                  </p>
                </div>
                {provider.provider_code !== "manual" && (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                )}
              </div>
            ))}
          </RadioGroup>
        )}
      </div>
    );
  }

  /* ---------- Step 2: details on RecordFormShell -------------------- */
  return (
    <RecordFormShell
      mode="create"
      entityLabel={
        isManualProvider
          ? "Bank account (manual)"
          : `Bank account via ${selectedProvider?.provider_name ?? ""}`
      }
      cancelHref="/finance/banking"
      onSubmit={onSubmit}
      isSubmitting={submit.isSubmitting}
      submitDisabled={submitDisabled}
      submitLabel={isManualProvider ? "Add account" : "Connect account"}
      extraLeadingActions={
        <Button
          type="button"
          variant="ghost"
          onClick={() => setStep(1)}
          disabled={submit.isSubmitting}
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          Back
        </Button>
      }
    >
      <Section title="Provider">
        <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
          {selectedProvider && (
            <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border bg-background">
              {renderProviderIcon(selectedProvider)}
            </div>
          )}
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium">{selectedProvider?.provider_name}</p>
              {selectedProvider?.is_sandbox && (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600">
                  Sandbox
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {isManualProvider
                ? "Manual entry — import statements via CSV"
                : "Auto-sync enabled"}
            </p>
          </div>
        </div>

        {isJengaProvider && (
          <>
            <Alert className="mt-4 border-amber-500/20 bg-amber-500/10">
              <TestTube className="h-4 w-4 text-amber-600" />
              <AlertTitle className="text-amber-700 dark:text-amber-400">
                Sandbox mode
              </AlertTitle>
              <AlertDescription className="text-sm text-amber-600 dark:text-amber-300">
                You're using Jenga's sandbox environment. Use one of the
                pre-configured test accounts below.
              </AlertDescription>
            </Alert>
            <div className="mt-4">
              <Label>Select test account</Label>
              <Select
                value={selectedTestAccount}
                onValueChange={setSelectedTestAccount}
              >
                <SelectTrigger className="mt-1.5">
                  <SelectValue placeholder="Choose a Jenga test account…" />
                </SelectTrigger>
                <SelectContent>
                  {JENGA_TEST_ACCOUNTS.map((acc) => (
                    <SelectItem key={acc.accountNumber} value={acc.accountNumber}>
                      <div className="flex items-center gap-2">
                        <span>{acc.label}</span>
                        <span className="text-xs text-muted-foreground">
                          ({acc.accountNumber} - {acc.currency})
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </Section>

      <Section title="Account details">
        <FieldGrid columns={2}>
          <FieldCell span="full">
            <Label>Account name *</Label>
            <Input
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="e.g., Main business account"
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
              placeholder="Enter your account number"
              disabled={
                isJengaProvider && useTestAccount && !!selectedTestAccount
              }
              className="mt-1.5"
            />
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

          <FieldCell>
            <Label>Currency</Label>
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              placeholder="KES"
              disabled={
                isJengaProvider && useTestAccount && !!selectedTestAccount
              }
              className="mt-1.5"
            />
          </FieldCell>

          <FieldCell>
            <Label>Opening balance</Label>
            <Input
              type="number"
              value={openingBalance}
              onChange={(e) => setOpeningBalance(e.target.value)}
              placeholder="0.00"
              className="mt-1.5"
            />
          </FieldCell>

          {isManualProvider && (
            <FieldCell>
              <Label>Opening balance date</Label>
              <Input
                type="date"
                value={openingBalanceDate}
                onChange={(e) => setOpeningBalanceDate(e.target.value)}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                The date as of which the opening balance is accurate
              </p>
            </FieldCell>
          )}
        </FieldGrid>
      </Section>

      <Section title="GL link">
        <FieldGrid columns={2}>
          <FieldCell span="full">
            <Label className="flex items-center gap-1">
              Link to Chart of Accounts
              <span className="text-destructive">*</span>
            </Label>
            <Select
              value={glAccountId}
              onValueChange={setGlAccountId}
              disabled={glLoading}
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue
                  placeholder={
                    glLoading ? "Loading GL accounts…" : "Select a GL account"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {dropdownGL.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} - {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Required. Drives reconciliation postings, balance tracking, and
              report classification.{" "}
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
              </p>
            )}
            {!glAccountId && (
              <p className="mt-1 text-xs text-destructive">
                A GL link is required before saving.
              </p>
            )}
          </FieldCell>
        </FieldGrid>
      </Section>

      {branches && branches.length > 0 && (
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
                      Branch users can only attach a new account to their own
                      branch. Switch to HQ to share across branches.
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
                  <SelectItem value="__all__">
                    All branches (company-wide)
                  </SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                      {b.is_headquarters ? " (HQ)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {branchSelectorLocked
                  ? "Bank connections are owned by the business. This account will be tagged to your branch; switch to HQ to share it across branches."
                  : "Choose a branch to scope this account to that location only, or leave as company-wide."}
              </p>
            </FieldCell>
          </FieldGrid>
        </Section>
      )}

      {selectedProvider &&
        selectedProvider.provider_code !== "manual" &&
        !isJengaProvider && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-4">
            <p className="text-sm text-blue-700 dark:text-blue-400">
              <strong>Note:</strong> After connecting, transactions will be
              synced automatically from your bank.
            </p>
          </div>
        )}

      {isJengaProvider && selectedTestAccount && (
        <Alert className="border-green-500/20 bg-green-500/10">
          <Info className="h-4 w-4 text-green-600" />
          <AlertTitle className="text-green-700 dark:text-green-400">
            Ready to connect
          </AlertTitle>
          <AlertDescription className="text-sm text-green-600 dark:text-green-300">
            After connecting, click "Sync" on the account card to fetch the
            test balance and transactions.
          </AlertDescription>
        </Alert>
      )}
    </RecordFormShell>
  );
}
