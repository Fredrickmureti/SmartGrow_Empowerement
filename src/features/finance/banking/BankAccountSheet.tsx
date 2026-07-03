/**
 * BankAccountSheet — Slice B5 · Step 1 (connect + edit, unified).
 *
 * URL-driven `DetailSheet` replacement for BOTH the legacy
 * `ConnectBankDialog` (create/connect) and `EditBankAccountDialog`
 * (edit). Same fields, same currency-lock guard, same branch
 * re-attribution confirmation, same opening-balance JE atomic post —
 * composed on the enterprise design-system scaffolds (`DetailSheet`,
 * `FieldGrid`, `FooterActionBar`) so the Banking list matches the
 * interaction language of the rest of Finance.
 *
 * Mount:
 *   `?sheet=account`               → connect (new account)
 *   `?sheet=account&id=<uuid>`     → edit existing account
 *
 * Connect is a two-step internal flow inside the sheet (provider
 * picker → details), matching the Odoo/QBO pattern. Edit is a single
 * step. Both share the same DetailSheet shell, footer, and design
 * tokens.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Loader2,
  Lock,
  AlertTriangle,
  Building2,
  Upload,
  CheckCircle2,
  TestTube,
  Info,
  ChevronLeft,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useBankAccounts, type BankAccount } from "@/hooks/useBankAccounts";
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
  DetailSheet,
  FieldGrid,
  FieldCell,
  FooterActionBar,
  ActionBar,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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

/* ------------------------------------------------------------------ */
/* Types + shared constants                                            */
/* ------------------------------------------------------------------ */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null → connect mode, non-null → edit mode. */
  account: BankAccount | null;
  onSuccess?: () => void;
}

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

/* ------------------------------------------------------------------ */
/* Public component — routes to Connect or Edit body                   */
/* ------------------------------------------------------------------ */

export function BankAccountSheet(props: Props) {
  const isEdit = !!props.account;
  return isEdit ? <EditBody {...props} /> : <ConnectBody {...props} />;
}

export default BankAccountSheet;

/* ------------------------------------------------------------------ */
/* Edit body — 1:1 port of the previous BankAccountEditSheet           */
/* ------------------------------------------------------------------ */

function EditBody({ open, onOpenChange, account, onSuccess }: Props) {
  const { updateAccount, isSaving } = useBankAccounts();
  const { accounts: glAccounts, isLoading: glLoading } = useAccounts();
  const scope = useFinanceScope();
  const { branches } = useBranch();

  const [name, setName] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [currency, setCurrency] = useState("");
  const [accountType, setAccountType] = useState("checking");
  const [glAccountId, setGlAccountId] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [isPrimary, setIsPrimary] = useState(false);
  const [hasTransactions, setHasTransactions] = useState(false);
  const [checkingTxns, setCheckingTxns] = useState(false);

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
    if (account && open) {
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
    }
  }, [account, open]);

  const originalBranchScope = account?.branch_id ?? "__all__";
  const branchChanged = branchScope !== originalBranchScope;
  const requiresReattributeConfirm = branchChanged && hasTransactions;

  useEffect(() => {
    if (!account || !open) return;
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
  }, [account, open]);

  const handleSave = async () => {
    if (!account || !name.trim()) return;
    if (isActive && !glAccountId) return;
    if (requiresReattributeConfirm && !reattributeConfirmed) return;
    const resolvedBranchId = branchScope === "__all__" ? null : branchScope;
    try {
      await updateAccount(account.id, {
        name: name.trim(),
        bank_name: bankName.trim() || undefined,
        account_number: accountNumber.trim() || undefined,
        currency: hasTransactions ? undefined : currency.toUpperCase(),
        account_type: accountType,
        account_id: glAccountId || null,
        is_primary: isPrimary,
        is_active: isActive,
        ...(branchChanged
          ? { branch_id: resolvedBranchId, is_shared: resolvedBranchId === null }
          : {}),
      });
      onOpenChange(false);
      onSuccess?.();
    } catch {
      /* toast handled in hook */
    }
  };

  const saveDisabled =
    isSaving ||
    !name.trim() ||
    (isActive && !glAccountId) ||
    !currency.trim() ||
    (requiresReattributeConfirm && !reattributeConfirmed);

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Edit bank account"
      description={account?.name}
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saveDisabled}>
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save changes
              </Button>
            </ActionBar>
          }
        />
      }
    >
      {account && (
        <div className="space-y-6 px-6 py-5">
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
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                maxLength={3}
                placeholder="e.g. USD"
                disabled={hasTransactions || checkingTxns}
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
                  Showing all active {bankGLAccounts[0]?.account_type}{" "}
                  accounts. For better filtering, set the Detail Type on your
                  bank/cash GL accounts.
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
                  , then reopen this sheet.
                </p>
              )}
              {isActive && !glAccountId && (
                <p className="mt-1 text-xs text-destructive">
                  A GL link is required to keep this account active.
                </p>
              )}
            </FieldCell>

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

            <FieldCell span="full">
              <Label className="flex items-center gap-1">
                Branch scope
                {branchSelectorLocked && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Lock className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Branch users can only manage accounts attached to their
                      own branch. Switch to the HQ branch to re-attribute.
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
                Bank credentials and GL link belong to the business. Branch is
                an analytic tag stamped on every transaction from this account.
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
                        onCheckedChange={(v) => setReattributeConfirmed(v === true)}
                      />
                      <span>I understand and want to re-attribute history</span>
                    </label>
                  </AlertDescription>
                </Alert>
              )}
            </FieldCell>
          </FieldGrid>
        </div>
      )}
    </DetailSheet>
  );
}

/* ------------------------------------------------------------------ */
/* Connect body — 1:1 port of the previous ConnectBankDialog           */
/* ------------------------------------------------------------------ */

function ConnectBody({ open, onOpenChange, onSuccess }: Props) {
  const { providers, isLoading: loadingProviders } = useBankProviders();
  const { createAccount, isSaving } = useBankAccounts();
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
    if (!open) {
      setStep(1);
      setSelectedProvider(null);
      setAccountName("");
      setAccountNumber("");
      setBankName("");
      setCurrency(currentBusiness?.base_currency ?? "");
      setOpeningBalance("");
      setOpeningBalanceDate(new Date().toISOString().split("T")[0]);
      setAccountType("checking");
      setGlAccountId("");
      setUseTestAccount(false);
      setSelectedTestAccount("");
      setBranchScope(
        branchSelectorLocked && scope.branchId ? scope.branchId : "__all__",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  const handleConnect = async () => {
    if (!selectedProvider) return;
    const resolvedBranchId = branchScope === "__all__" ? null : branchScope;
    try {
      const newAccount = await createAccount({
        name: accountName,
        bank_name: bankName,
        account_number: accountNumber,
        currency,
        current_balance: openingBalance ? parseFloat(openingBalance) : 0,
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
        // R5: is_shared mirrors branch_id presence — DB CHECK enforces this.
        is_shared: resolvedBranchId === null,
      } as any);

      // Opening-balance JE via the canonical atomic RPC — inherits balance
      // enforcement, fiscal-period locks, idempotency, and account-balance
      // side effects in one transaction.
      const parsedBalance = openingBalance ? parseFloat(openingBalance) : 0;
      if (glAccountId && parsedBalance > 0 && newAccount?.id) {
        try {
          const equityAccount = glAccounts?.find(
            (a) =>
              a.account_type === "equity" &&
              (a.detail_type === "opening_balance_equity" ||
                a.name.toLowerCase().includes("opening balance")),
          );
          if (equityAccount) {
            const { data: userData } = await supabase.auth.getUser();
            const { data: bankAcct } = await supabase
              .from("bank_accounts")
              .select("organization_id, business_id")
              .eq("id", newAccount.id)
              .single();
            const orgId = bankAcct?.organization_id;
            if (orgId) {
              const entryDate = isManualProvider
                ? openingBalanceDate
                : new Date().toISOString().split("T")[0];
              const { error: rpcError } = await supabase.rpc(
                "post_journal_entry_atomic",
                {
                  _org_id: orgId,
                  _business_id: bankAcct?.business_id ?? null,
                  _entry_number: null,
                  _entry_date: entryDate,
                  _reference: `OB-BANK-${newAccount.id.slice(0, 8)}`,
                  _description: `Opening balance - ${accountName}`,
                  _source_type: "opening_balance",
                  _source_id: newAccount.id,
                  _source_subtype: "main",
                  _created_by: userData.user?.id ?? null,
                  _is_closing: false,
                  _is_adjusting: false,
                  _lines: [
                    {
                      account_id: glAccountId,
                      debit: parsedBalance,
                      credit: 0,
                      description: `Opening balance - ${accountName}`,
                    },
                    {
                      account_id: equityAccount.id,
                      debit: 0,
                      credit: parsedBalance,
                      description: `Opening balance - ${accountName}`,
                    },
                  ],
                } as any,
              );
              if (rpcError)
                console.warn(
                  "Opening balance JE creation failed (non-blocking):",
                  rpcError,
                );
            }
          }
        } catch (e) {
          console.warn("Opening balance JE creation failed (non-blocking):", e);
        }
      }

      onOpenChange(false);
      onSuccess?.();
    } catch {
      /* toast handled in hook */
    }
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

  const connectDisabled =
    isSaving ||
    !accountName ||
    !glAccountId ||
    !currency.trim() ||
    (isJengaProvider && !selectedTestAccount);

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        step === 1
          ? "Add bank account"
          : isManualProvider
            ? "Add bank account (manual)"
            : `Connect via ${selectedProvider?.provider_name ?? ""}`
      }
      description={
        step === 1
          ? "Add a manual bank account or connect a live integration"
          : isManualProvider
            ? "Enter your bank account details — you can import statements later"
            : "Enter your bank account details"
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            step === 2 ? (
              <Button
                variant="ghost"
                onClick={() => setStep(1)}
                disabled={isSaving}
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
            ) : undefined
          }
          trailing={
            <ActionBar>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSaving}
              >
                Cancel
              </Button>
              {step === 2 && (
                <Button onClick={handleConnect} disabled={connectDisabled}>
                  {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {isManualProvider ? "Add account" : "Connect account"}
                </Button>
              )}
            </ActionBar>
          }
        />
      }
    >
      {step === 1 && (
        <div className="space-y-3 px-6 py-5">
          {loadingProviders ? (
            <div className="flex items-center justify-center py-8">
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
      )}

      {step === 2 && selectedProvider && (
        <div className="space-y-6 px-6 py-5">
          <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
            <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border bg-background">
              {renderProviderIcon(selectedProvider)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="font-medium">{selectedProvider.provider_name}</p>
                {selectedProvider.is_sandbox && (
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
              <Alert className="border-amber-500/20 bg-amber-500/10">
                <TestTube className="h-4 w-4 text-amber-600" />
                <AlertTitle className="text-amber-700 dark:text-amber-400">
                  Sandbox mode
                </AlertTitle>
                <AlertDescription className="text-sm text-amber-600 dark:text-amber-300">
                  You're using Jenga's sandbox environment. Use one of the
                  pre-configured test accounts below.
                </AlertDescription>
              </Alert>
              <FieldCell span="full">
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
              </FieldCell>
            </>
          )}

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
                  Set the Detail Type on your bank/cash GL accounts in the
                  Chart of Accounts for tighter filtering.
                </p>
              )}
              {!glLoading && bankGLAccounts.length === 0 && (
                <p className="mt-1 text-xs text-amber-600">
                  No active{" "}
                  {accountType === "credit_card" || accountType === "loan"
                    ? "liability"
                    : "asset"}{" "}
                  GL accounts found — create one in the Chart of Accounts first.
                </p>
              )}
              {!glAccountId && (
                <p className="mt-1 text-xs text-destructive">
                  A GL link is required before saving.
                </p>
              )}
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

            {branches && branches.length > 0 && (
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
            )}

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

          {selectedProvider.provider_code !== "manual" && !isJengaProvider && (
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
        </div>
      )}
    </DetailSheet>
  );
}
