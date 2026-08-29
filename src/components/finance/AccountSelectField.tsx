/**
 * AccountSelectField
 *
 * Labelled chart-of-accounts picker used by contact/party forms to override a
 * default posting account. Replaces the removed product-module selector; it is
 * a thin wrapper over AccountCombobox so account selection stays on one
 * component across the app.
 */
import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { useAccounts } from "@/hooks/useAccounts";

type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

interface AccountSelectFieldProps {
  label: string;
  value: string | null | undefined;
  onChange: (value: string) => void;
  /** Restrict the picker to one side of the books. */
  accountType?: AccountType;
  /**
   * Legacy prop kept for call-site compatibility. The system default account
   * is resolved server-side when this field is left empty, so nothing to do here.
   */
  defaultKey?: string;
  helpText?: string;
  disabled?: boolean;
}

export function AccountSelectField({
  label,
  value,
  onChange,
  accountType,
  helpText,
  disabled = false,
}: AccountSelectFieldProps) {
  const { accounts, isLoading } = useAccounts();

  const options = useMemo(
    () => accounts.filter((account) => account.is_active),
    [accounts],
  );

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <AccountCombobox
        accounts={options}
        value={value ?? ""}
        onValueChange={onChange}
        disabled={disabled || isLoading}
        placeholder="Use system default"
        {...(accountType ? { allowedTypes: [accountType] } : {})}
      />
      {helpText ? <p className="text-xs text-muted-foreground">{helpText}</p> : null}
    </div>
  );
}
