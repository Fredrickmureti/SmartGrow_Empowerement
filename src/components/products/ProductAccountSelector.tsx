import { useAccounts } from "@/hooks/useAccounts";
import { Label } from "@/components/ui/label";
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
}

export function ProductAccountSelector({
  label,
  value,
  onChange,
  accountType,
  helpText,
  disabled,
}: ProductAccountSelectorProps) {
  const { accounts, isLoading } = useAccounts();

  const filteredAccounts = accounts.filter(
    (a) => a.account_type === accountType && a.is_active
  );

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select
        value={value || "none"}
        onValueChange={(v) => onChange(v === "none" ? null : v)}
        disabled={disabled || isLoading}
      >
        <SelectTrigger>
          <SelectValue placeholder={isLoading ? "Loading..." : "Use system default"} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Use system default</SelectItem>
          {filteredAccounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              <span className="font-mono text-xs text-muted-foreground mr-2">{account.code}</span>
              {account.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {helpText && (
        <p className="text-xs text-muted-foreground">{helpText}</p>
      )}
    </div>
  );
}
