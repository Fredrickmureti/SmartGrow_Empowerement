/**
 * RuleFormBody — shared form body for RuleCreatePage + RuleEditPage.
 *
 * Extracted verbatim from the legacy `TransactionRulesDialog` create/edit
 * card. Presentational only; the parent page owns state and submit.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import type { Account } from "@/hooks/useAccounts";
import type { BankAccount } from "@/hooks/useBankAccounts";

export interface RuleFormValues {
  rule_name: string;
  description_pattern: string;
  reference_pattern: string;
  min_amount?: number;
  max_amount?: number;
  transaction_type: string;
  target_category: string;
  priority: number;
  is_active: boolean;
  auto_action: string;
  auto_post: boolean;
  auto_offset_account_id: string;
  use_regex: boolean;
  stop_processing: boolean;
  bank_account_id: string;
}

export const emptyRuleForm: RuleFormValues = {
  rule_name: "",
  description_pattern: "",
  reference_pattern: "",
  min_amount: undefined,
  max_amount: undefined,
  transaction_type: "both",
  target_category: "",
  priority: 0,
  is_active: true,
  auto_action: "categorize",
  auto_post: false,
  auto_offset_account_id: "",
  use_regex: false,
  stop_processing: false,
  bank_account_id: "",
};

const TRANSACTION_TYPES = [
  { value: "both", label: "All Types" },
  { value: "debit", label: "Expense / Payment" },
  { value: "credit", label: "Deposit / Receipt" },
];

const AUTO_ACTIONS = [
  { value: "categorize", label: "Categorize Only" },
  { value: "create_je", label: "Create Journal Entry" },
  { value: "match_invoice", label: "Match to Invoice/Bill" },
];

interface RuleFormBodyProps {
  values: RuleFormValues;
  onChange: (next: RuleFormValues) => void;
  glAccounts: Account[];
  bankAccounts: BankAccount[];
}

export function RuleFormBody({
  values,
  onChange,
  glAccounts,
  bankAccounts,
}: RuleFormBodyProps) {
  const patch = (next: Partial<RuleFormValues>) => onChange({ ...values, ...next });

  return (
    <div className="space-y-4">
      {/* Row 1: Name + GL Account */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Rule Name *</Label>
          <Input
            value={values.rule_name}
            onChange={(e) => patch({ rule_name: e.target.value })}
            placeholder="e.g., MPESA Sales"
            className="text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Target Account (GL) *</Label>
          <AccountCombobox
            accounts={glAccounts}
            value={values.target_category}
            onValueChange={(value) => patch({ target_category: value })}
            placeholder="Select GL account..."
          />
        </div>
      </div>

      {/* Row 2: Pattern + Reference */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Description Pattern *</Label>
          <Input
            value={values.description_pattern}
            onChange={(e) => patch({ description_pattern: e.target.value })}
            placeholder={values.use_regex ? "e.g., MPESA.*SALES" : "e.g., MPESA|SAFARICOM"}
          />
          <p className="text-[10px] sm:text-xs text-muted-foreground">
            {values.use_regex ? "Regular expression pattern" : "Use | for OR matching"}
          </p>
        </div>
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Reference Pattern</Label>
          <Input
            value={values.reference_pattern}
            onChange={(e) => patch({ reference_pattern: e.target.value })}
            placeholder="Optional pattern"
          />
        </div>
      </div>

      {/* Row 3: Type, Amount Range, Priority */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Transaction Type</Label>
          <Select
            value={values.transaction_type}
            onValueChange={(value) => patch({ transaction_type: value })}
          >
            <SelectTrigger className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSACTION_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Min Amount</Label>
          <Input
            type="number"
            value={values.min_amount ?? ""}
            onChange={(e) => patch({ min_amount: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="-"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Max Amount</Label>
          <Input
            type="number"
            value={values.max_amount ?? ""}
            onChange={(e) => patch({ max_amount: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="-"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Priority</Label>
          <Input
            type="number"
            value={values.priority || 0}
            onChange={(e) => patch({ priority: Number(e.target.value) })}
            placeholder="0"
          />
        </div>
      </div>

      <Separator />

      {/* Row 4: Auto-action */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Auto Action</Label>
          <Select
            value={values.auto_action}
            onValueChange={(value) => patch({ auto_action: value })}
          >
            <SelectTrigger className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTO_ACTIONS.map((a) => (
                <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {values.auto_action === "create_je" && (
          <div className="space-y-2">
            <Label className="text-xs sm:text-sm">Offset Account</Label>
            <AccountCombobox
              accounts={glAccounts}
              value={values.auto_offset_account_id}
              onValueChange={(value) => patch({ auto_offset_account_id: value })}
              placeholder="Select offset account..."
            />
          </div>
        )}
      </div>

      {/* Bank account scope */}
      <div className="space-y-2">
        <Label className="text-xs sm:text-sm">Apply to Bank Account</Label>
        <Select
          value={values.bank_account_id || "all"}
          onValueChange={(value) => patch({ bank_account_id: value === "all" ? "" : value })}
        >
          <SelectTrigger className="text-sm">
            <SelectValue placeholder="All accounts" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All bank accounts</SelectItem>
            {bankAccounts.filter((a) => a.is_active).map((acc) => (
              <SelectItem key={acc.id} value={acc.id}>
                {acc.name} — {acc.bank_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Toggles */}
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center space-x-2">
          <Switch
            checked={values.is_active}
            onCheckedChange={(checked) => patch({ is_active: checked })}
          />
          <Label className="text-xs sm:text-sm">Active</Label>
        </div>
        <div className="flex items-center space-x-2">
          <Switch
            checked={values.use_regex}
            onCheckedChange={(checked) => patch({ use_regex: checked })}
          />
          <Label className="text-xs sm:text-sm">Use Regex</Label>
        </div>
        <div className="flex items-center space-x-2">
          <Switch
            checked={values.auto_post}
            onCheckedChange={(checked) => patch({ auto_post: checked })}
          />
          <Label className="text-xs sm:text-sm">Auto-Post JE</Label>
        </div>
        <div className="flex items-center space-x-2">
          <Switch
            checked={values.stop_processing}
            onCheckedChange={(checked) => patch({ stop_processing: checked })}
          />
          <Label className="text-xs sm:text-sm">Stop Processing</Label>
        </div>
      </div>
    </div>
  );
}

export function buildRulePayload(values: RuleFormValues) {
  return {
    rule_name: values.rule_name,
    description_pattern: values.description_pattern,
    reference_pattern: values.reference_pattern || undefined,
    min_amount: values.min_amount,
    max_amount: values.max_amount,
    transaction_type: values.transaction_type,
    target_category: values.target_category,
    priority: values.priority,
    is_active: values.is_active,
    auto_action: values.auto_action || undefined,
    auto_post: values.auto_post || undefined,
    auto_offset_account_id: values.auto_offset_account_id || undefined,
    use_regex: values.use_regex || undefined,
    stop_processing: values.stop_processing || undefined,
    bank_account_id: values.bank_account_id || undefined,
  };
}
