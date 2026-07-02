import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBankAccounts, BankAccount } from "@/hooks/useBankAccounts";
import { useAccounts } from "@/hooks/useAccounts";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";
import { useBranch } from "@/contexts/BranchContext";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Edit, Lock, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  BANK_ACCOUNT_TYPES,
  filterGLAccountsForBankType,
  fallbackGLAccountsForBankType,
} from "@/lib/bankAccountTypes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Link } from "react-router-dom";

interface EditBankAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: BankAccount | null;
  onSuccess?: () => void;
}

export function EditBankAccountDialog({
  open,
  onOpenChange,
  account,
  onSuccess,
}: EditBankAccountDialogProps) {
  const { updateAccount, isSaving } = useBankAccounts();
  const { accounts: glAccounts, isLoading: glLoading } = useAccounts();
  const scope = useFinanceScope();
  const { branches } = useBranch();

  const [name, setName] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [accountType, setAccountType] = useState("checking");
  const [glAccountId, setGlAccountId] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [isPrimary, setIsPrimary] = useState(false);
  const [hasTransactions, setHasTransactions] = useState(false);
  const [checkingTxns, setCheckingTxns] = useState(false);

  // G1 — branch scope is owned by the business. Branch users may not move
  // an account to another branch; HQ / consolidated may freely choose.
  // The cascade trigger re-stamps bank_transactions/sessions when branch
  // changes, so when history exists we require explicit confirmation.
  const branchSelectorLocked = !scope.isHeadquartersContext && !scope.isConsolidated;
  const [branchScope, setBranchScope] = useState<string>("__all__");
  const [reattributeConfirmed, setReattributeConfirmed] = useState(false);

  // Dynamic GL filtering based on selected bank account type. Strict
  // structured-detail-type match first; if that's empty, surface a lenient
  // account-type-only fallback so the dropdown is never silently empty
  // (Odoo/QBO/Xero behaviour: always show something pickable on edit).
  const strictGL = filterGLAccountsForBankType(glAccounts || [], accountType);
  const usedFallback = strictGL.length === 0;
  const bankGLAccounts = usedFallback
    ? fallbackGLAccountsForBankType(glAccounts || [], accountType)
    : strictGL;
  // Preserve the currently-linked GL account in the dropdown even if it no
  // longer matches the new account_type filter — never silently drop a link.
  const linkedGL = glAccountId ? (glAccounts || []).find(a => a.id === glAccountId) : null;
  const dropdownGL = linkedGL && !bankGLAccounts.some(a => a.id === linkedGL.id)
    ? [linkedGL, ...bankGLAccounts]
    : bankGLAccounts;

  useEffect(() => {
    if (account && open) {
      setName(account.name || "");
      setBankName(account.bank_name || "");
      setAccountNumber(account.account_number || "");
      // Currency MUST come from the account itself. We do not invent USD.
      // If the account has no currency stored (legacy data), the field is
      // empty and the user is forced to pick one before save.
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

  // When the dialog opens, check whether this account already has any bank
  // transactions OR posted journal-entry lines on its linked GL account.
  // If either exists, currency is locked — Odoo blocks currency changes
  // once any journal entry exists, because the historical lines were posted
  // at the old currency and re-stamping would silently re-value the books.
  // Bank-transactions-only was insufficient: an opening-balance JE posts
  // directly via post_journal_entry_atomic without creating a bank_transaction
  // row, so the old check missed it.
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
    // GL link is required for active accounts (Odoo: bank journals require
    // default_account_id). Inactive accounts may be saved unlinked.
    if (isActive && !glAccountId) {
      // soft-block via the disabled state on the Save button
      return;
    }
    if (requiresReattributeConfirm && !reattributeConfirmed) return;
    const resolvedBranchId = branchScope === "__all__" ? null : branchScope;
    try {
      await updateAccount(account.id, {
        name: name.trim(),
        bank_name: bankName.trim() || undefined,
        account_number: accountNumber.trim() || undefined,
        // Only send currency if it is unlocked (no transactions yet).
        currency: hasTransactions ? undefined : currency.toUpperCase(),
        account_type: accountType,
        account_id: glAccountId || null,
        is_primary: isPrimary,
        is_active: isActive,
        // Only send branch fields when the user actually moved the scope —
        // avoids re-tagging history on every cosmetic save.
        ...(branchChanged
          ? { branch_id: resolvedBranchId, is_shared: resolvedBranchId === null }
          : {}),
      });
      onOpenChange(false);
      onSuccess?.();
    } catch {
      // Error handled in hook
    }
  };

  if (!account) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Edit className="h-5 w-5 text-primary" />
            Edit Bank Account
          </DialogTitle>
          <DialogDescription>
            Update the details for this bank account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Account Name *</Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Main Business Account"
            />
          </div>

          <div className="space-y-2">
            <Label>Bank Name</Label>
            <Input
              value={bankName}
              onChange={e => setBankName(e.target.value)}
              placeholder="e.g., Equity Bank"
            />
          </div>

          <div className="space-y-2">
            <Label>Account Number</Label>
            <Input
              value={accountNumber}
              onChange={e => setAccountNumber(e.target.value)}
              placeholder="Enter account number"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="flex items-center gap-1">
                Currency
                {hasTransactions && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Lock className="h-3 w-3 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Locked: this account has posted bank transactions.
                      Changing the currency would silently re-value the books.
                    </TooltipContent>
                  </Tooltip>
                )}
              </Label>
              <Input
                value={currency}
                onChange={e => setCurrency(e.target.value.toUpperCase())}
                maxLength={3}
                placeholder="e.g. USD"
                disabled={hasTransactions || checkingTxns}
              />
            </div>
            <div className="space-y-2">
              <Label>Account Type</Label>
              <Select value={accountType} onValueChange={(v) => {
                setAccountType(v);
                // Do NOT reset the link automatically. Odoo/QBO never silently
                // unlink — if the new type is incompatible, the dropdown
                // surfaces the mismatch via dropdownGL and the user decides.
              }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BANK_ACCOUNT_TYPES.map(t => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/*
            GL link — ALWAYS rendered. This is the most important field on
            the bank account form (Odoo, QuickBooks and Xero all keep it
            permanently visible and required). Hiding it when the filtered
            list is empty was a bug: the warning banner on /banking told
            users to "edit the account to add one" but the field then
            disappeared, leaving them stuck.
          */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1">
              Link to GL Account
              {isActive && <span className="text-destructive">*</span>}
            </Label>
            <Select
              value={glAccountId || "__none__"}
              onValueChange={v => setGlAccountId(v === "__none__" ? "" : v)}
              disabled={glLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder={glLoading ? "Loading GL accounts…" : "Select a GL account"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None (inactive only)</SelectItem>
                {dropdownGL.map(a => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} — {a.name}
                    {linkedGL?.id === a.id && a.account_type !== bankGLAccounts[0]?.account_type
                      ? " (current link, type mismatch)"
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Required for active accounts. Drives balance derivation, reconciliation postings, and report classification.{" "}
              <Link to="/finance/chart-of-accounts" target="_blank" rel="noopener" className="underline">
                + Create new GL account
              </Link>
            </p>
            {!glLoading && usedFallback && bankGLAccounts.length > 0 && (
              <p className="text-xs text-amber-600">
                No GL accounts are explicitly tagged for this bank type. Showing all active{" "}
                {bankGLAccounts[0]?.account_type} accounts. For better filtering, set the
                Detail Type on your bank/cash GL accounts in the Chart of Accounts.
              </p>
            )}
            {!glLoading && bankGLAccounts.length === 0 && (
              <p className="text-xs text-amber-600">
                No active {accountType === "credit_card" || accountType === "loan" ? "liability" : "asset"} GL accounts found.{" "}
                <Link to="/finance/chart-of-accounts" target="_blank" rel="noopener" className="underline">
                  Create one in Chart of Accounts
                </Link>
                , then reopen this dialog.
              </p>
            )}
            {isActive && !glAccountId && (
              <p className="text-xs text-destructive">
                A GL link is required to keep this account active.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label className="text-sm">Primary Account</Label>
              <p className="text-xs text-muted-foreground">Set as the default bank account</p>
            </div>
            <Switch checked={isPrimary} onCheckedChange={setIsPrimary} />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label className="text-sm">Active</Label>
              <p className="text-xs text-muted-foreground">Inactive accounts are hidden from selections</p>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          {/* G1 — Branch scope. Owned by the business; branch users are locked. */}
          <div className="space-y-2">
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
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Shared across all branches</SelectItem>
                {(branches || []).map(b => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}{b.is_headquarters ? " (HQ)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Bank credentials and GL link belong to the business. Branch is an
              analytic tag stamped on every transaction from this account.
            </p>
            {requiresReattributeConfirm && (
              <Alert variant="destructive">
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
                      onCheckedChange={v => setReattributeConfirmed(v === true)}
                    />
                    <span>I understand and want to re-attribute history</span>
                  </label>
                </AlertDescription>
              </Alert>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              isSaving ||
              !name.trim() ||
              (isActive && !glAccountId) ||
              !currency.trim() ||
              (requiresReattributeConfirm && !reattributeConfirmed)
            }
          >
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
