/**
 * RuleFormBody — shared form body for RuleCreatePage + RuleEditPage.
 *
 * Phase 4 of the reconciliation wave: rules are authored into the one table the
 * executor actually reads (`bank_reconciliation_rules`). The form therefore
 * speaks the accounting vocabulary — a rule names the account the residual is
 * posted to, not a free-text "category" — and every field on this form is a
 * field the engine honours. Fields with no backing behaviour (the old
 * `auto_action`, `stop_processing` and offset-account controls) were removed
 * rather than left as decoration.
 *
 * Presentational only; the parent page owns state and submit.
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
import type { Branch } from "@/contexts/BranchContext";
import type { ReconciliationRuleInput } from "@/hooks/finance/useReconciliationRules";

export interface RuleFormValues {
  name: string;
  pattern: string;
  /** When true the pattern is a regular expression, otherwise an ILIKE pattern. */
  use_regex: boolean;
  reference_pattern: string;
  amount_min?: number;
  amount_max?: number;
  amount_sign: "any" | "debit" | "credit";
  counterpart_account_id: string;
  description_template: string;
  priority: number;
  is_active: boolean;
  auto_post: boolean;
  bank_account_id: string;
  branch_id: string;
}

export const emptyRuleForm: RuleFormValues = {
  name: "",
  pattern: "",
  use_regex: false,
  reference_pattern: "",
  amount_min: undefined,
  amount_max: undefined,
  amount_sign: "any",
  counterpart_account_id: "",
  description_template: "",
  priority: 100,
  is_active: true,
  auto_post: false,
  bank_account_id: "",
  branch_id: "",
};

const AMOUNT_SIGNS = [
  { value: "any", label: "All lines" },
  { value: "debit", label: "Money out (payments)" },
  { value: "credit", label: "Money in (receipts)" },
];

interface RuleFormBodyProps {
  values: RuleFormValues;
  onChange: (next: RuleFormValues) => void;
  glAccounts: Account[];
  bankAccounts: BankAccount[];
  branches: Branch[];
}

export function RuleFormBody({
  values,
  onChange,
  glAccounts,
  bankAccounts,
  branches,
}: RuleFormBodyProps) {
  const patch = (next: Partial<RuleFormValues>) => onChange({ ...values, ...next });

  return (
    <div className="space-y-4">
      {/* Row 1: Name + counterpart account */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Rule Name *</Label>
          <Input
            value={values.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="e.g., Bank charges"
            className="text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Post to Account *</Label>
          <AccountCombobox
            accounts={glAccounts}
            value={values.counterpart_account_id}
            onValueChange={(value) => patch({ counterpart_account_id: value })}
            placeholder="Select GL account..."
          />
          <p className="text-[10px] sm:text-xs text-muted-foreground">
            The other side of the entry when this rule explains a line.
          </p>
        </div>
      </div>

      {/* Row 2: Pattern + reference */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Description Pattern *</Label>
          <Input
            value={values.pattern}
            onChange={(e) => patch({ pattern: e.target.value })}
            placeholder={values.use_regex ? "e.g., LEDGER FEE|CHARGE" : "e.g., %LEDGER FEE%"}
          />
          <p className="text-[10px] sm:text-xs text-muted-foreground">
            {values.use_regex
              ? "Regular expression, matched case-insensitively"
              : "Use % as a wildcard, e.g. %BANK CHARGE%"}
          </p>
        </div>
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Reference Pattern</Label>
          <Input
            value={values.reference_pattern}
            onChange={(e) => patch({ reference_pattern: e.target.value })}
            placeholder="Optional, e.g. %FEE%"
          />
        </div>
      </div>

      {/* Row 3: Direction, amount range, priority */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Applies To</Label>
          <Select
            value={values.amount_sign}
            onValueChange={(value) => patch({ amount_sign: value as RuleFormValues["amount_sign"] })}
          >
            <SelectTrigger className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AMOUNT_SIGNS.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Min Amount</Label>
          <Input
            type="number"
            value={values.amount_min ?? ""}
            onChange={(e) => patch({ amount_min: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="-"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Max Amount</Label>
          <Input
            type="number"
            value={values.amount_max ?? ""}
            onChange={(e) => patch({ amount_max: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="-"
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Priority</Label>
          <Input
            type="number"
            value={values.priority}
            onChange={(e) => patch({ priority: Number(e.target.value) })}
            placeholder="100"
          />
          <p className="text-[10px] text-muted-foreground">Lower runs first.</p>
        </div>
      </div>

      <Separator />

      {/* Scope */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
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
        <div className="space-y-2">
          <Label className="text-xs sm:text-sm">Apply to Branch</Label>
          <Select
            value={values.branch_id || "all"}
            onValueChange={(value) => patch({ branch_id: value === "all" ? "" : value })}
          >
            <SelectTrigger className="text-sm">
              <SelectValue placeholder="All branches" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All branches</SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] sm:text-xs text-muted-foreground">
            A rule never explains a line from another branch.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs sm:text-sm">Entry Description</Label>
        <Input
          value={values.description_template}
          onChange={(e) => patch({ description_template: e.target.value })}
          placeholder="Optional — defaults to the bank line description"
        />
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
          <div>
            <Label className="text-xs sm:text-sm">Post Automatically</Label>
            <p className="text-[10px] text-muted-foreground">
              Off: the rule leaves a proposal for a human to confirm.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function buildRulePayload(values: RuleFormValues): ReconciliationRuleInput {
  const pattern = values.pattern.trim();
  return {
    name: values.name.trim(),
    branch_id: values.branch_id || null,
    bank_account_id: values.bank_account_id || null,
    priority: values.priority,
    is_active: values.is_active,
    description_pattern: values.use_regex ? null : pattern || null,
    description_regex: values.use_regex ? pattern || null : null,
    reference_pattern: values.reference_pattern.trim() || null,
    amount_min: values.amount_min ?? null,
    amount_max: values.amount_max ?? null,
    amount_sign: values.amount_sign,
    counterpart_contact_id: null,
    counterpart_account_id: values.counterpart_account_id,
    journal_book_id: null,
    auto_post: values.auto_post,
    description_template: values.description_template.trim() || null,
  };
}
