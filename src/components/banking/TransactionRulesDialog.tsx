import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTransactionRules, CreateRuleInput } from "@/hooks/useTransactionRules";
import { useAccounts } from "@/hooks/useAccounts";
import { useBankAccounts } from "@/hooks/useBankAccounts";
import { AccountCombobox } from "@/components/finance/AccountCombobox";
import { Plus, Trash2, Edit2, Save, X, Loader2, Sparkles } from "lucide-react";

interface TransactionRulesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromTransaction?: {
    description: string;
    reference?: string | null;
    amount: number;
    transaction_type: "credit" | "debit";
  };
}

// Accounting-meaningful transaction types
const TRANSACTION_TYPES = [
  { value: "both", label: "All Types" },
  { value: "debit", label: "Expense / Payment" },
  { value: "credit", label: "Deposit / Receipt" },
];

// Auto-action options matching R4 fields
const AUTO_ACTIONS = [
  { value: "categorize", label: "Categorize Only" },
  { value: "create_je", label: "Create Journal Entry" },
  { value: "match_invoice", label: "Match to Invoice/Bill" },
];

interface RuleFormData {
  id?: string;
  rule_name: string;
  description_pattern: string;
  reference_pattern: string;
  min_amount?: number;
  max_amount?: number;
  transaction_type: string;
  target_category: string;
  priority: number;
  is_active: boolean;
  // R4 fields
  auto_action: string;
  auto_post: boolean;
  auto_offset_account_id: string;
  use_regex: boolean;
  stop_processing: boolean;
  bank_account_id: string;
  memo: string;
}

export function TransactionRulesDialog({
  open,
  onOpenChange,
  fromTransaction,
}: TransactionRulesDialogProps) {
  const {
    rules,
    isLoading,
    isSaving,
    createRule,
    updateRule,
    deleteRule,
    toggleRuleActive,
  } = useTransactionRules();
  const { accounts: glAccounts } = useAccounts();
  const { accounts: bankAccounts } = useBankAccounts();

  const [editingRule, setEditingRule] = useState<RuleFormData | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const emptyRule: RuleFormData = {
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
    memo: "",
  };

  useEffect(() => {
    if (open && fromTransaction) {
      const words = fromTransaction.description.split(/\s+/).filter((w) => w.length > 3);
      const pattern = words.slice(0, 2).join(" ").toUpperCase();
      setEditingRule({
        ...emptyRule,
        rule_name: `Auto: ${pattern}`,
        description_pattern: pattern,
        transaction_type: fromTransaction.transaction_type,
      });
      setIsCreating(true);
    }
  }, [open, fromTransaction]);

  const handleSave = async () => {
    if (!editingRule) return;
    if (!editingRule.rule_name || !editingRule.description_pattern || !editingRule.target_category) return;

    const ruleData: CreateRuleInput = {
      rule_name: editingRule.rule_name,
      description_pattern: editingRule.description_pattern,
      reference_pattern: editingRule.reference_pattern || undefined,
      min_amount: editingRule.min_amount,
      max_amount: editingRule.max_amount,
      transaction_type: editingRule.transaction_type,
      target_category: editingRule.target_category,
      priority: editingRule.priority,
      is_active: editingRule.is_active,
      auto_action: editingRule.auto_action || undefined,
      auto_post: editingRule.auto_post || undefined,
      auto_offset_account_id: editingRule.auto_offset_account_id || undefined,
      use_regex: editingRule.use_regex || undefined,
      stop_processing: editingRule.stop_processing || undefined,
      bank_account_id: editingRule.bank_account_id || undefined,
    };

    if (isCreating) {
      const result = await createRule(ruleData);
      if (result) { setEditingRule(null); setIsCreating(false); }
    } else if (editingRule.id) {
      const success = await updateRule(editingRule.id, ruleData);
      if (success) { setEditingRule(null); setIsCreating(false); }
    }
  };

  const handleDelete = async (id: string) => {
    await deleteRule(id);
  };

  const handleAddNew = () => {
    setEditingRule(emptyRule);
    setIsCreating(true);
  };

  const handleCancel = () => {
    setEditingRule(null);
    setIsCreating(false);
  };

  const handleToggleActive = async (id: string, currentState: boolean | null) => {
    await toggleRuleActive(id, !currentState);
  };

  // Get account name for display
  const getAccountName = (accountId: string) => {
    const account = glAccounts?.find(a => a.id === accountId);
    return account ? `${account.code} — ${account.name}` : accountId;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] sm:max-w-2xl md:max-w-4xl max-h-[90vh] overflow-y-auto p-3 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Sparkles className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
            Transaction Rules
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 sm:space-y-4">
          <p className="text-xs sm:text-sm text-muted-foreground">
            Create rules to automatically categorize and process bank transactions. Rules map to your Chart of Accounts.
          </p>

          {/* Edit/Create Form */}
          {editingRule && (
            <Card>
              <CardHeader className="pb-3 px-3 sm:px-6 pt-4 sm:pt-6">
                <CardTitle className="text-sm sm:text-base">
                  {isCreating ? "Create New Rule" : "Edit Rule"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 px-3 sm:px-6">
                {/* Row 1: Name + GL Account */}
                <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs sm:text-sm">Rule Name *</Label>
                    <Input
                      value={editingRule.rule_name}
                      onChange={(e) => setEditingRule({ ...editingRule, rule_name: e.target.value })}
                      placeholder="e.g., MPESA Sales"
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs sm:text-sm">Target Account (GL) *</Label>
                    <AccountCombobox
                      accounts={glAccounts || []}
                      value={editingRule.target_category}
                      onValueChange={(value) => setEditingRule({ ...editingRule, target_category: value })}
                      placeholder="Select GL account..."
                    />
                  </div>
                </div>

                {/* Row 2: Pattern + Reference */}
                <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs sm:text-sm">Description Pattern *</Label>
                    <Input
                      value={editingRule.description_pattern}
                      onChange={(e) => setEditingRule({ ...editingRule, description_pattern: e.target.value })}
                      placeholder={editingRule.use_regex ? "e.g., MPESA.*SALES" : "e.g., MPESA|SAFARICOM"}
                    />
                    <p className="text-[10px] sm:text-xs text-muted-foreground">
                      {editingRule.use_regex ? "Regular expression pattern" : "Use | for OR matching"}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs sm:text-sm">Reference Pattern</Label>
                    <Input
                      value={editingRule.reference_pattern}
                      onChange={(e) => setEditingRule({ ...editingRule, reference_pattern: e.target.value })}
                      placeholder="Optional pattern"
                    />
                  </div>
                </div>

                {/* Row 3: Type, Amount Range, Priority */}
                <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
                  <div className="space-y-2">
                    <Label className="text-xs sm:text-sm">Transaction Type</Label>
                    <Select
                      value={editingRule.transaction_type}
                      onValueChange={(value) => setEditingRule({ ...editingRule, transaction_type: value })}
                    >
                      <SelectTrigger className="text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TRANSACTION_TYPES.map(t => (
                          <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs sm:text-sm">Min Amount</Label>
                    <Input
                      type="number"
                      value={editingRule.min_amount || ""}
                      onChange={(e) => setEditingRule({ ...editingRule, min_amount: e.target.value ? Number(e.target.value) : undefined })}
                      placeholder="-"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs sm:text-sm">Max Amount</Label>
                    <Input
                      type="number"
                      value={editingRule.max_amount || ""}
                      onChange={(e) => setEditingRule({ ...editingRule, max_amount: e.target.value ? Number(e.target.value) : undefined })}
                      placeholder="-"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs sm:text-sm">Priority</Label>
                    <Input
                      type="number"
                      value={editingRule.priority || 0}
                      onChange={(e) => setEditingRule({ ...editingRule, priority: Number(e.target.value) })}
                      placeholder="0"
                    />
                  </div>
                </div>

                <Separator />

                {/* Row 4: Auto-action settings */}
                <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs sm:text-sm">Auto Action</Label>
                    <Select
                      value={editingRule.auto_action}
                      onValueChange={(value) => setEditingRule({ ...editingRule, auto_action: value })}
                    >
                      <SelectTrigger className="text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AUTO_ACTIONS.map(a => (
                          <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {editingRule.auto_action === "create_je" && (
                    <div className="space-y-2">
                      <Label className="text-xs sm:text-sm">Offset Account</Label>
                      <AccountCombobox
                        accounts={glAccounts || []}
                        value={editingRule.auto_offset_account_id}
                        onValueChange={(value) => setEditingRule({ ...editingRule, auto_offset_account_id: value })}
                        placeholder="Select offset account..."
                      />
                    </div>
                  )}
                </div>

                {/* Bank account scope */}
                <div className="space-y-2">
                  <Label className="text-xs sm:text-sm">Apply to Bank Account</Label>
                  <Select
                    value={editingRule.bank_account_id || "all"}
                    onValueChange={(value) => setEditingRule({ ...editingRule, bank_account_id: value === "all" ? "" : value })}
                  >
                    <SelectTrigger className="text-sm">
                      <SelectValue placeholder="All accounts" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All bank accounts</SelectItem>
                      {bankAccounts?.filter(a => a.is_active).map(acc => (
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
                      checked={editingRule.is_active}
                      onCheckedChange={(checked) => setEditingRule({ ...editingRule, is_active: checked })}
                    />
                    <Label className="text-xs sm:text-sm">Active</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch
                      checked={editingRule.use_regex}
                      onCheckedChange={(checked) => setEditingRule({ ...editingRule, use_regex: checked })}
                    />
                    <Label className="text-xs sm:text-sm">Use Regex</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch
                      checked={editingRule.auto_post}
                      onCheckedChange={(checked) => setEditingRule({ ...editingRule, auto_post: checked })}
                    />
                    <Label className="text-xs sm:text-sm">Auto-Post JE</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch
                      checked={editingRule.stop_processing}
                      onCheckedChange={(checked) => setEditingRule({ ...editingRule, stop_processing: checked })}
                    />
                    <Label className="text-xs sm:text-sm">Stop Processing</Label>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={handleCancel} disabled={isSaving} size="sm">
                    <X className="mr-1.5 h-4 w-4" />
                    Cancel
                  </Button>
                  <Button onClick={handleSave} disabled={isSaving} size="sm">
                    {isSaving ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-1.5 h-4 w-4" />
                    )}
                    Save Rule
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Rules List */}
          {!editingRule && (
            <>
              <div className="flex justify-between items-center">
                <p className="text-xs sm:text-sm text-muted-foreground">
                  {rules.length} rule{rules.length !== 1 ? "s" : ""} configured
                </p>
                <Button onClick={handleAddNew} size="sm">
                  <Plus className="mr-1.5 h-4 w-4" />
                  Create Rule
                </Button>
              </div>

              {isLoading ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : (
                <div className="overflow-x-auto -mx-3 sm:mx-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs sm:text-sm">Rule</TableHead>
                        <TableHead className="text-xs sm:text-sm hidden sm:table-cell">Pattern</TableHead>
                        <TableHead className="text-xs sm:text-sm hidden xs:table-cell">Type</TableHead>
                        <TableHead className="text-xs sm:text-sm">Account</TableHead>
                        <TableHead className="text-xs sm:text-sm hidden md:table-cell">Action</TableHead>
                        <TableHead className="text-xs sm:text-sm hidden xs:table-cell">Active</TableHead>
                        <TableHead className="text-right text-xs sm:text-sm">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rules.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="h-24 text-center text-sm">
                            No rules created yet. Create a rule to automatically categorize transactions.
                          </TableCell>
                        </TableRow>
                      ) : (
                        rules.map((rule) => (
                          <TableRow key={rule.id}>
                            <TableCell className="font-medium text-xs sm:text-sm py-2">
                              <span className="truncate max-w-[100px] sm:max-w-none block">{rule.rule_name}</span>
                            </TableCell>
                            <TableCell className="text-muted-foreground font-mono text-[10px] sm:text-xs max-w-[150px] truncate hidden sm:table-cell">
                              {rule.description_pattern}
                              {(rule as any).use_regex && (
                                <Badge variant="outline" className="ml-1 text-[9px]">regex</Badge>
                              )}
                            </TableCell>
                            <TableCell className="hidden xs:table-cell">
                              <Badge variant="outline" className="text-[10px] sm:text-xs">
                                {rule.transaction_type === "both" ? "All" : rule.transaction_type === "credit" ? "Deposit" : "Payment"}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Badge variant="secondary" className="text-[10px] sm:text-xs max-w-[120px] truncate block">
                                {/* Show GL account name if it's a UUID, otherwise show the category */}
                                {rule.target_category && rule.target_category.includes("-")
                                  ? getAccountName(rule.target_category)
                                  : rule.target_category}
                              </Badge>
                            </TableCell>
                            <TableCell className="hidden md:table-cell">
                              <Badge variant="outline" className="text-[10px]">
                                {(rule as any).auto_action || "categorize"}
                              </Badge>
                            </TableCell>
                            <TableCell className="hidden xs:table-cell">
                              <Switch
                                checked={rule.is_active ?? true}
                                onCheckedChange={() => handleToggleActive(rule.id, rule.is_active)}
                                disabled={isSaving}
                              />
                            </TableCell>
                            <TableCell className="text-right py-2">
                              <div className="flex justify-end gap-0.5">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => {
                                    setEditingRule({
                                      id: rule.id,
                                      rule_name: rule.rule_name,
                                      description_pattern: rule.description_pattern || "",
                                      reference_pattern: rule.reference_pattern || "",
                                      min_amount: rule.min_amount || undefined,
                                      max_amount: rule.max_amount || undefined,
                                      transaction_type: rule.transaction_type || "both",
                                      target_category: rule.target_category,
                                      priority: rule.priority || 0,
                                      is_active: rule.is_active ?? true,
                                      auto_action: (rule as any).auto_action || "categorize",
                                      auto_post: (rule as any).auto_post ?? false,
                                      auto_offset_account_id: (rule as any).auto_offset_account_id || "",
                                      use_regex: (rule as any).use_regex ?? false,
                                      stop_processing: (rule as any).stop_processing ?? false,
                                      bank_account_id: (rule as any).bank_account_id || "",
                                      memo: "",
                                    });
                                    setIsCreating(false);
                                  }}
                                >
                                  <Edit2 className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => handleDelete(rule.id)}
                                  disabled={isSaving}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
