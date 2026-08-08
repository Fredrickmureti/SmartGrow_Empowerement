/**
 * ProductAccountSelector — inheritance-aware GL account field.
 *
 * Enterprise ledgers (Odoo, NetSuite, Oracle Fusion) never ask an operator to
 * accept an invisible posting rule: when a field inherits, they show the
 * *effective* account plus where it came from. This component does the same.
 *
 * States:
 *   - Inherited  → shows "4000 — Sales Revenue" muted + "Default" badge
 *   - Override   → shows the chosen account + "Override" badge + reset action
 *   - Unmapped   → amber warning + link to Finance → Settings (default accounts)
 *
 * Presentation only: the posting ladder itself is unchanged
 * (line override → product → company default, see src/lib/resolveProductAccounts.ts).
 */
import { useAccounts } from "@/hooks/useAccounts";
import { useDefaultAccounts, type DefaultAccountMappings } from "@/hooks/useDefaultAccounts";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Link } from "react-router-dom";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ProductAccountSelectorProps {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  accountType: "income" | "expense" | "asset" | "liability";
  helpText?: string;
  disabled?: boolean;
  /**
   * Which company-level default backs this field when no override is set.
   * Required to name the inherited account instead of the opaque phrase
   * an opaque placeholder.
   */
  defaultKey?: keyof DefaultAccountMappings;
  /**
   * Category tier (ADR 0122). When the product's category — or its nearest
   * ancestor — defines this account, it outranks the company default and the
   * field is labelled "From category …".
   */
  categoryDefault?: { accountId?: string | null; categoryName?: string | null };
}

export function ProductAccountSelector({
  label,
  value,
  onChange,
  accountType,
  helpText,
  disabled,
  defaultKey,
  categoryDefault,
}: ProductAccountSelectorProps) {
  const { accounts, isLoading } = useAccounts();
  const { accounts: defaults, isReady } = useDefaultAccounts();

  const filteredAccounts = accounts.filter(
    (a) => a.account_type === accountType && a.is_active
  );

  // Ladder for the *inherited* value: category → company default.
  const inheritedFromCategory = !!categoryDefault?.accountId;
  const defaultAccountId = inheritedFromCategory
    ? categoryDefault!.accountId!
    : defaultKey
      ? defaults[defaultKey]
      : undefined;
  const defaultAccount = defaultAccountId
    ? accounts.find((a) => a.id === defaultAccountId)
    : undefined;
  const defaultLabel = defaultAccount
    ? `${defaultAccount.code} — ${defaultAccount.name}`
    : undefined;
  const sourceLabel = inheritedFromCategory
    ? `From category${categoryDefault?.categoryName ? ` "${categoryDefault.categoryName}"` : ""}`
    : "Default";

  const isOverridden = !!value;
  // Only warn once both the account list and the mappings have resolved.
  const isUnmapped =
    !!defaultKey && !isOverridden && isReady && !isLoading && !defaultAccountId;

  const placeholder = isLoading
    ? "Loading…"
    : defaultLabel
      ? `${defaultLabel} (default)`
      : "No default mapped — select an account";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label>{label}</Label>
        {isOverridden ? (
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium">
            Override
          </Badge>
        ) : defaultLabel ? (
          <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-medium">
            {sourceLabel}
          </Badge>
        ) : null}
        {isOverridden && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-xs text-muted-foreground"
            onClick={() => onChange(null)}
            disabled={disabled}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Reset
          </Button>
        )}
      </div>
      <Select
        value={value || "none"}
        onValueChange={(v) => onChange(v === "none" ? null : v)}
        disabled={disabled || isLoading}
      >
        <SelectTrigger className={!isOverridden ? "text-muted-foreground" : undefined}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">
            {defaultLabel ? (
              <span>
                <span className="mr-2 font-mono text-xs text-muted-foreground">
                  {defaultAccount!.code}
                </span>
                {defaultAccount!.name}
                <span className="ml-2 text-xs text-muted-foreground">
                  ({inheritedFromCategory ? "category default" : "system default"})
                </span>
              </span>
            ) : (
              "No default mapped"
            )}
          </SelectItem>
          {filteredAccounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              <span className="font-mono text-xs text-muted-foreground mr-2">{account.code}</span>
              {account.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isUnmapped && (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            No system default mapped — postings that rely on this account will fail.{" "}
            <Link to="/finance/settings" className="underline underline-offset-2">
              Configure default accounts
            </Link>
          </span>
        </p>
      )}
      {helpText && (
        <p className="text-xs text-muted-foreground">{helpText}</p>
      )}
    </div>
  );
}
