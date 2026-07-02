import { Switch } from "@/components/ui/switch";
import { useAccounts } from "@/hooks/useAccounts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScopeChip } from "@/components/settings/ScopeChip";
import type { POSPaymentMethod } from "@/hooks/pos/usePOSSettings";

interface PaymentMethodRowProps {
  method: POSPaymentMethod;
  IconComponent: React.ElementType;
  onToggle: (methodKey: string, isEnabled: boolean) => void;
  onAccountChange: (methodKey: string, accountId: string | null) => void;
  isPending: boolean;
}

export function PaymentMethodRow({
  method,
  IconComponent,
  onToggle,
  onAccountChange,
  isPending,
}: PaymentMethodRowProps) {
  const { accounts, isLoading: accountsLoading } = useAccounts();

  // Filter to asset accounts (cash, bank, receivables) for debit side
  const assetAccounts = accounts.filter(
    (a) => a.account_type === "asset" && a.is_active
  );

  return (
    <div className="p-3 border rounded-lg space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${method.is_enabled ? 'bg-primary/10' : 'bg-muted'}`}>
            <IconComponent className={`h-5 w-5 ${method.is_enabled ? 'text-primary' : 'text-muted-foreground'}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium">{method.display_name}</p>
              {/* Branch-override badge: NULL branch_id = company-shared default,
                  set value = branch-specific override (Odoo-aligned scoping). */}
              <ScopeChip
                scope={method.branch_id ? "branch" : "company"}
                label={method.branch_id ? "Branch override" : "Shared"}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {method.requires_reference ? "Requires reference" : "No reference required"}
            </p>
          </div>
        </div>
        <Switch
          checked={method.is_enabled}
          onCheckedChange={(checked) => onToggle(method.method_key, checked)}
          disabled={isPending}
        />
      </div>
      {method.is_enabled && (
        <div className="pl-12">
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            GL Debit Account
          </label>
          <Select
            value={method.debit_account_id || "default"}
            onValueChange={(v) => onAccountChange(method.method_key, v === "default" ? null : v)}
            disabled={accountsLoading || isPending}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder={accountsLoading ? "Loading..." : "Use system default"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Use system default (Cash/Bank)</SelectItem>
              {assetAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  <span className="font-mono text-xs text-muted-foreground mr-2">{account.code}</span>
                  {account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
