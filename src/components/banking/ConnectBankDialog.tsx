import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
// SCOPE-TRIGGER-EXEMPT: form selector for branch on a bank connection, not a scope switcher
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { useBankProviders, BankProvider } from "@/hooks/useBankProviders";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { useAccounts } from "@/hooks/useAccounts";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { toast } from "sonner";
import {
  BANK_ACCOUNT_TYPES,
  filterGLAccountsForBankType,
  fallbackGLAccountsForBankType,
} from "@/lib/bankAccountTypes";
import {
  Building2,
  Loader2,
  Upload,
  CheckCircle2,
  AlertTriangle,
  TestTube,
  Info,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Link } from "react-router-dom";

interface ConnectBankDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

const JENGA_TEST_ACCOUNTS = [
  { label: "Equity Kenya Test 1", accountNumber: "1100194977404", bankCode: "68", currency: "KES", country: "KE" },
  { label: "Equity Kenya Test 2", accountNumber: "0020100014605", bankCode: "68", currency: "KES", country: "KE" },
  { label: "Equity Kenya Test 3", accountNumber: "1450160649886", bankCode: "68", currency: "KES", country: "KE" },
  { label: "Equity Kenya USD", accountNumber: "0810178838044", bankCode: "68", currency: "USD", country: "KE" },
];

// Hardcoded manual option — always available, never admin-controlled
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

// Account types now imported from shared constants

export function ConnectBankDialog({ open, onOpenChange, onSuccess }: ConnectBankDialogProps) {
  const { providers, isLoading: loadingProviders } = useBankProviders();
  const { createAccount, isSaving } = useBankAccounts();
  const { accounts: glAccounts, isLoading: glLoading } = useAccounts();
  
  const [step, setStep] = useState(1);
  const [selectedProvider, setSelectedProvider] = useState<BankProvider | null>(null);
  const [useTestAccount, setUseTestAccount] = useState(false);
  const [selectedTestAccount, setSelectedTestAccount] = useState<string>("");
  
  // Form state
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { branches } = useBranch();
  const scope = useFinanceScope();
  const [currency, setCurrency] = useState(currentBusiness?.base_currency ?? "");
  const [openingBalance, setOpeningBalance] = useState("");
  const [openingBalanceDate, setOpeningBalanceDate] = useState(new Date().toISOString().split('T')[0]);
  const [accountType, setAccountType] = useState("checking");
  const [glAccountId, setGlAccountId] = useState("");
  // Branch users may only attach an account to their own branch; HQ /
  // consolidated may pick any branch or company-wide. Bank credentials and
  // the GL link still belong to the business — branch is an analytic tag.
  const branchSelectorLocked = !scope.isHeadquartersContext && !scope.isConsolidated;
  const [branchScope, setBranchScope] = useState<string>(
    branchSelectorLocked && scope.branchId ? scope.branchId : "__all__",
  );

  // Build provider list: manual first (always), then enabled live integrations
  const liveProviders = providers.filter(p => p.is_enabled && p.provider_code !== "manual");
  const allProviders = [MANUAL_PROVIDER_OPTION, ...liveProviders];

  const isJengaProvider = selectedProvider?.provider_code === "jenga" && selectedProvider?.is_sandbox;
  const isManualProvider = selectedProvider?.provider_code === "manual";

  // Dynamic GL filtering based on selected bank account type. Strict
  // detail-type match first; fall back to all GLs of the right account_type
  // so the dropdown is never silently empty (matches Edit dialog behaviour).
  const strictGL = filterGLAccountsForBankType(glAccounts || [], accountType);
  const usedFallback = strictGL.length === 0;
  const bankGLAccounts = usedFallback
    ? fallbackGLAccountsForBankType(glAccounts || [], accountType)
    : strictGL;
  const linkedGL = glAccountId ? (glAccounts || []).find(a => a.id === glAccountId) : null;
  const dropdownGL = linkedGL && !bankGLAccounts.some(a => a.id === linkedGL.id)
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
      setOpeningBalanceDate(new Date().toISOString().split('T')[0]);
      setAccountType("checking");
      setGlAccountId("");
      setUseTestAccount(false);
      setSelectedTestAccount("");
      setBranchScope("__all__");
    }
  }, [open]);

  useEffect(() => {
    if (selectedTestAccount && useTestAccount) {
      const testAcc = JENGA_TEST_ACCOUNTS.find(a => a.accountNumber === selectedTestAccount);
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
      setBankName(provider.provider_name.replace(" API", "").replace(" (Equity Bank)", ""));
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
        account_id: glAccountId || undefined, // GL account link
        provider_id: selectedProvider.provider_code !== "manual" && selectedProvider.id !== "__manual__" ? selectedProvider.id : undefined,
        external_account_id: accountNumber || undefined,
        branch_id: resolvedBranchId,
        // R5: is_shared mirrors branch_id presence — DB CHECK enforces this.
        is_shared: resolvedBranchId === null,
      } as any);
      
      // Post opening balance JE if GL account is linked and balance > 0.
      // Routes through the canonical post_journal_entry_atomic RPC so the entry
      // inherits balance enforcement, fiscal-period locks, idempotency
      // (source_type='opening_balance', source_id=bank_account.id, subtype='main'),
      // and account-balance side effects in ONE atomic transaction.
      const parsedBalance = openingBalance ? parseFloat(openingBalance) : 0;
      if (glAccountId && parsedBalance > 0 && newAccount?.id) {
        try {
          const equityAccount = glAccounts?.find(a =>
            a.account_type === "equity" &&
            (a.detail_type === "opening_balance_equity" || a.name.toLowerCase().includes("opening balance"))
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
              const entryDate = isManualProvider ? openingBalanceDate : new Date().toISOString().split('T')[0];
              const { error: rpcError } = await supabase.rpc("post_journal_entry_atomic", {
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
                  { account_id: glAccountId, debit: parsedBalance, credit: 0, description: `Opening balance - ${accountName}` },
                  { account_id: equityAccount.id, debit: 0, credit: parsedBalance, description: `Opening balance - ${accountName}` },
                ],
              } as any);
              if (rpcError) console.warn("Opening balance JE creation failed (non-blocking):", rpcError);
            }
          }
        } catch (e) {
          console.warn("Opening balance JE creation failed (non-blocking):", e);
        }
      }

      onOpenChange(false);
      onSuccess?.();
    } catch {
      // Error handled in hook
    }
  };

  const renderProviderIcon = (provider: BankProvider) => {
    if (provider.provider_code === "manual") {
      return <Upload className="h-5 w-5" />;
    }
    if (provider.logo_url) {
      return (
        <img 
          src={provider.logo_url} 
          alt={provider.provider_name}
          className="h-8 w-8 object-contain"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
            const fallback = e.currentTarget.nextElementSibling as HTMLElement;
            if (fallback) fallback.style.display = 'block';
          }}
        />
      );
    }
    return <Building2 className="h-5 w-5" />;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 1 ? "Add Bank Account" : isManualProvider ? "Add Bank Account (Manual)" : `Connect via ${selectedProvider?.provider_name}`}
          </DialogTitle>
          <DialogDescription>
            {step === 1 
              ? "Add a manual bank account or connect a live integration"
              : isManualProvider
                ? "Enter your bank account details — you can import statements later"
                : "Enter your bank account details"
            }
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="py-4">
            {loadingProviders ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <RadioGroup className="space-y-3">
                {allProviders.map((provider) => (
                  <div
                    key={provider.id}
                    className="flex items-center space-x-4 rounded-lg border p-4 cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => handleSelectProvider(provider)}
                  >
                    <RadioGroupItem value={provider.id} id={provider.id} />
                    <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
                      {renderProviderIcon(provider)}
                      {provider.logo_url && provider.provider_code !== "manual" && (
                        <Building2 className="h-5 w-5 hidden" />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Label htmlFor={provider.id} className="font-medium cursor-pointer">
                          {provider.provider_name}
                        </Label>
                        {provider.is_sandbox && (
                          <span className="text-xs bg-amber-500/10 text-amber-600 px-2 py-0.5 rounded-full flex items-center gap-1">
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
          <div className="space-y-4 py-4">
            {/* Show selected bank with logo */}
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
              <div className="h-10 w-10 rounded-lg bg-background flex items-center justify-center overflow-hidden border">
                {renderProviderIcon(selectedProvider)}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-medium">{selectedProvider.provider_name}</p>
                  {selectedProvider.is_sandbox && (
                    <span className="text-xs bg-amber-500/10 text-amber-600 px-2 py-0.5 rounded-full">
                      Sandbox
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {isManualProvider ? "Manual entry — import statements via CSV" : "Auto-sync enabled"}
                </p>
              </div>
            </div>

            {/* Sandbox Test Account Selector for Jenga */}
            {isJengaProvider && (
              <>
                <Alert className="bg-amber-500/10 border-amber-500/20">
                  <TestTube className="h-4 w-4 text-amber-600" />
                  <AlertTitle className="text-amber-700 dark:text-amber-400">Sandbox Mode</AlertTitle>
                  <AlertDescription className="text-amber-600 dark:text-amber-300 text-sm">
                    You're using Jenga's sandbox environment. Use one of the pre-configured test accounts below.
                  </AlertDescription>
                </Alert>
                <div className="space-y-2">
                  <Label>Select Test Account</Label>
                  <Select value={selectedTestAccount} onValueChange={setSelectedTestAccount}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a Jenga test account..." />
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

            <div className="space-y-2">
              <Label htmlFor="account-name">Account Name *</Label>
              <Input
                id="account-name"
                placeholder="e.g., Main Business Account"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="bank-name">Bank Name</Label>
              <Input
                id="bank-name"
                placeholder="e.g., Equity Bank"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="account-number">Account Number</Label>
              <Input
                id="account-number"
                placeholder="Enter your account number"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
                disabled={isJengaProvider && useTestAccount && !!selectedTestAccount}
              />
            </div>

            {/* Account Type — shown for ALL providers */}
            <div className="space-y-2">
              <Label>Account Type</Label>
              <Select value={accountType} onValueChange={(v) => {
                setAccountType(v);
                // Do NOT reset glAccountId — Odoo/QBO preserve the user's
                // pick across type changes. The dropdown will surface a
                // type-mismatch hint if the new type no longer matches.
              }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BANK_ACCOUNT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/*
              GL Account Link — ALWAYS rendered (Odoo / QuickBooks / Xero
              never hide this field). Required for the bank account to feed
              the trial balance and reconciliation. We preserve any
              currently-chosen value even if the type filter no longer
              matches it.
            */}
            <div className="space-y-2">
              <Label className="flex items-center gap-1">
                Link to Chart of Accounts
                <span className="text-destructive">*</span>
              </Label>
              <Select value={glAccountId} onValueChange={setGlAccountId} disabled={glLoading}>
                <SelectTrigger>
                  <SelectValue placeholder={glLoading ? "Loading GL accounts…" : "Select a GL account"} />
                </SelectTrigger>
                <SelectContent>
                  {dropdownGL.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} - {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Required. Drives reconciliation postings, balance tracking, and report classification.{" "}
                <Link to="/finance/chart-of-accounts" target="_blank" rel="noopener" className="underline">
                  + Create new GL account
                </Link>
              </p>
              {!glLoading && usedFallback && bankGLAccounts.length > 0 && (
                <p className="text-xs text-amber-600">
                  No GL accounts are explicitly tagged for this bank type. Showing all
                  active {bankGLAccounts[0]?.account_type} accounts. Set the Detail Type
                  on your bank/cash GL accounts in the Chart of Accounts for tighter filtering.
                </p>
              )}
              {!glLoading && bankGLAccounts.length === 0 && (
                <p className="text-xs text-amber-600">
                  No active {accountType === "credit_card" || accountType === "loan" ? "liability" : "asset"} GL accounts found —
                  create one in the Chart of Accounts first.
                </p>
              )}
              {!glAccountId && (
                <p className="text-xs text-destructive mt-1">
                  A GL link is required before saving.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="currency">Currency</Label>
                <Input
                  id="currency"
                  placeholder="KES"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  maxLength={3}
                  disabled={isJengaProvider && useTestAccount && !!selectedTestAccount}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="opening-balance">Opening Balance</Label>
                <Input
                  id="opening-balance"
                  type="number"
                  placeholder="0.00"
                  value={openingBalance}
                  onChange={(e) => setOpeningBalance(e.target.value)}
                />
              </div>
            </div>

            {/* Branch scope — credentials always belong to the business; this is
                an analytic tag. Branch users are locked to their own branch. */}
            {branches && branches.length > 0 && (
              <div className="space-y-2">
                <Label>Branch scope</Label>
                <Select
                  value={branchScope}
                  onValueChange={setBranchScope}
                  disabled={branchSelectorLocked}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All branches (company-wide)</SelectItem>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}{b.is_headquarters ? " (HQ)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {branchSelectorLocked
                    ? "Bank connections are owned by the business. This account will be tagged to your branch; switch to HQ to share it across branches."
                    : "Choose a branch to scope this account to that location only, or leave as company-wide."}
                </p>
              </div>
            )}

            {/* Opening Balance Date — manual only */}
            {isManualProvider && (
              <div className="space-y-2">
                <Label htmlFor="opening-balance-date">Opening Balance Date</Label>
                <Input
                  id="opening-balance-date"
                  type="date"
                  value={openingBalanceDate}
                  onChange={(e) => setOpeningBalanceDate(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The date as of which the opening balance is accurate
                </p>
              </div>
            )}

            {selectedProvider.provider_code !== "manual" && !isJengaProvider && (
              <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <p className="text-sm text-blue-700 dark:text-blue-400">
                  <strong>Note:</strong> After connecting, transactions will be synced automatically from your bank.
                </p>
              </div>
            )}

            {isJengaProvider && selectedTestAccount && (
              <Alert className="bg-green-500/10 border-green-500/20">
                <Info className="h-4 w-4 text-green-600" />
                <AlertTitle className="text-green-700 dark:text-green-400">Ready to Connect</AlertTitle>
                <AlertDescription className="text-green-600 dark:text-green-300 text-sm">
                  After connecting, click "Sync" on the account card to fetch the test balance and transactions.
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 2 && (
            <Button variant="outline" onClick={() => setStep(1)}>
              Back
            </Button>
          )}
          {step === 1 && (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
          {step === 2 && (
            <Button 
              onClick={handleConnect} 
              disabled={
                isSaving ||
                !accountName ||
                !glAccountId ||
                !currency.trim() ||
                (isJengaProvider && !selectedTestAccount)
              }
            >
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isManualProvider ? "Add Account" : "Connect Account"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
