/**
 * BankAccountEditSheet — Slice B5 · Step 1 (edit half).
 *
 * URL-driven `DetailSheet` replacement for the legacy
 * `EditBankAccountDialog`. Same fields, same currency-lock guard,
 * same branch re-attribution confirmation — but composed on the
 * enterprise design-system scaffolds (`DetailSheet`, `FieldGrid`,
 * `FooterActionBar`) so the Banking list matches the interaction
 * language of the rest of Finance.
 *
 * Mount:  `?sheet=account&id=<uuid>` on `/finance/banking`.
 *
 * The create/connect half of Step 1 (replacing `ConnectBankDialog`)
 * lands in the next iteration — that dialog is a multi-step provider
 * picker + atomic opening-balance JE post and warrants its own careful
 * migration to `WizardShell`. Tracked in `.lovable/plan.md`.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Lock, AlertTriangle } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useBankAccounts, type BankAccount } from "@/hooks/useBankAccounts";
import { useAccounts } from "@/hooks/useAccounts";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: BankAccount | null;
  onSuccess?: () => void;
}

export function BankAccountEditSheet({
  open,
  onOpenChange,
  account,
  onSuccess,
}: Props) {
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

  // Same GL-filter policy as the legacy dialog: strict detail-type match,
  // then account-type fallback so the dropdown is never silently empty.
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

  // Currency lock: any posted bank transaction OR any journal-entry line on
  // the linked GL account freezes the currency (opening-balance JEs don't
  // create bank_transaction rows, so both probes are required).
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
      // toast handled in hook
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
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSaving}
              >
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
                onValueChange={(v) =>
                  setGlAccountId(v === "__none__" ? "" : v)
                }
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
                  <p className="text-xs text-muted-foreground">
                    Default bank account
                  </p>
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
                  <SelectItem value="__all__">
                    Shared across all branches
                  </SelectItem>
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
                an analytic tag stamped on every transaction from this
                account.
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
        </div>
      )}
    </DetailSheet>
  );
}

export default BankAccountEditSheet;
