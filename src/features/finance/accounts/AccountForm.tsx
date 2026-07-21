/**
 * AccountForm — shared create/edit form for Chart of Accounts, composed
 * on `RecordFormShell`. Rendered by `/finance/accounts/new` and
 * `/finance/accounts/:id/edit`. Preserves every business rule from the
 * legacy inline dialog verbatim: detail-type filtering by category,
 * sub-account parent pick-list, opening-balance guardrail (create-only),
 * system-account lock, toast wording, and permission/branch banners.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertCircle, BookOpen } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RecordFormShell,
  Section,
  FieldGrid,
  FieldCell,
} from "@/design-system";
import { useAccounts, type Account } from "@/hooks/useAccounts";
import { useAccountBalances } from "@/hooks/useAccountBalances";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import {
  ACCOUNT_CATEGORIES,
  getDetailTypesForCategory,
  getDefaultDetailTypeForCategory,
  getSuggestedNames,
  getDetailTypeDescription,
  getCategoryValue,
} from "@/lib/accountDetailTypes";

interface AccountFormProps {
  mode: "create" | "edit";
  account?: Account | null;
}

export function AccountForm({ mode, account }: AccountFormProps) {
  const navigate = useNavigate();
  const { accounts, createAccount, updateAccount } = useAccounts();
  const { getEffectiveBalance: rpcBalance } = useAccountBalances();
  const { toast } = useToast();

  const initialCategory =
    account?.account_type
      ? getCategoryValue(account.account_type, account.detail_type ?? null)
      : "bank";

  const [formData, setFormData] = useState({
    account_type: (account?.account_type ?? "asset") as Account["account_type"],
    category: initialCategory,
    detail_type:
      account?.detail_type ?? getDefaultDetailTypeForCategory(initialCategory),
    code: account?.code ?? "",
    name: account?.name ?? "",
    description: account?.description ?? "",
    opening_balance: account?.opening_balance ?? 0,
    is_sub_account: !!account?.parent_id,
    parent_id: account?.parent_id ?? "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const detailTypes = getDetailTypesForCategory(formData.category);
  const nameSuggestions = formData.detail_type
    ? getSuggestedNames(formData.account_type, formData.detail_type)
    : [];
  const selectedDetailTypeDescription = formData.detail_type
    ? getDetailTypeDescription(formData.account_type, formData.detail_type)
    : "";

  const parentCandidates = useMemo(
    () =>
      accounts.filter(
        (a) =>
          a.account_type === formData.account_type &&
          a.is_active &&
          a.id !== account?.id &&
          !a.parent_id,
      ),
    [accounts, formData.account_type, account?.id],
  );

  const isSystem = mode === "edit" && !!account?.is_system;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!formData.detail_type) {
      toast({
        title: "Detail Type is required",
        description:
          "Please select a Detail Type to ensure correct financial report classification.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const { is_sub_account, category: _category, opening_balance: _ob, ...dbFields } = formData;
      const parent_id = is_sub_account && formData.parent_id ? formData.parent_id : null;

      if (mode === "edit" && account) {
        await updateAccount(account.id, {
          ...dbFields,
          detail_type: dbFields.detail_type || null,
          parent_id,
        });
        toast({ title: "Account updated successfully" });
      } else {
        await createAccount({
          ...dbFields,
          opening_balance: formData.opening_balance,
          detail_type: dbFields.detail_type || null,
          is_active: true,
          is_system: false,
          current_balance: 0,
          parent_id,
        });
        toast({ title: "Account created successfully" });
      }
      navigate("/finance/accounts");
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode={mode}
      entityLabel="Account"
      recordRef={account?.code}
      meta={
        mode === "edit"
          ? `${account?.code ?? ""} · ${account?.name ?? ""}`
          : "Create a new account for your chart of accounts."
      }
      cancelHref="/finance/accounts"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel={mode === "edit" ? "Update Account" : "Create Account"}
    >
      <Section title="Classification">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="account_type">
              Account Type *
              {isSystem && (
                <Badge variant="secondary" className="ml-2 text-[10px] font-normal">
                  System account
                </Badge>
              )}
            </Label>
            <Select
              value={formData.category}
              onValueChange={(catValue) => {
                const cat = ACCOUNT_CATEGORIES.find((c) => c.value === catValue);
                if (cat) {
                  const newDetailType = getDefaultDetailTypeForCategory(catValue);
                  setFormData({
                    ...formData,
                    account_type: cat.baseType,
                    category: catValue,
                    detail_type: newDetailType,
                    name: mode === "edit" ? formData.name : "",
                  });
                }
              }}
              disabled={isSystem}
            >
              <SelectTrigger id="account_type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                  Balance Sheet
                </div>
                {ACCOUNT_CATEGORIES.filter((c) => c.group === "Balance Sheet").map((cat) => (
                  <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                ))}
                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground border-t mt-1 pt-1.5">
                  Income &amp; Expense
                </div>
                {ACCOUNT_CATEGORIES.filter((c) => c.group === "Income & Expense").map((cat) => (
                  <SelectItem key={cat.value} value={cat.value}>{cat.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="detail_type">Detail Type *</Label>
            {detailTypes.length <= 1 ? (
              <Input
                value={detailTypes.length === 1 ? detailTypes[0].label : "—"}
                disabled
                className="bg-muted cursor-not-allowed"
              />
            ) : (
              <Select
                value={formData.detail_type || "none"}
                onValueChange={(value) => {
                  const dt = value === "none" ? "" : value;
                  setFormData({ ...formData, detail_type: dt });
                }}
              >
                <SelectTrigger id="detail_type">
                  <SelectValue placeholder="Select detail type..." />
                </SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  {detailTypes.map((dt) => (
                    <SelectItem key={dt.value} value={dt.value}>{dt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {selectedDetailTypeDescription && (
            <FieldCell span={2}>
              <div className="rounded-md border border-border bg-muted/50 px-3 py-2">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {selectedDetailTypeDescription}
                </p>
              </div>
            </FieldCell>
          )}
        </FieldGrid>
      </Section>

      <Section title="Identity">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="code">Account Code *</Label>
            <Input
              id="code"
              value={formData.code}
              onChange={(e) => setFormData({ ...formData, code: e.target.value })}
              placeholder="e.g., 1000"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">Account Name *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder={nameSuggestions[0] || "Enter account name"}
              required
              list="name-suggestions"
            />
            {nameSuggestions.length > 0 && (
              <datalist id="name-suggestions">
                {nameSuggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            )}
          </div>
          <FieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={2}
              />
            </div>
          </FieldCell>
        </FieldGrid>
      </Section>

      <Section title="Hierarchy">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="is_sub_account"
              checked={formData.is_sub_account}
              onCheckedChange={(checked) =>
                setFormData({ ...formData, is_sub_account: !!checked, parent_id: "" })
              }
            />
            <Label htmlFor="is_sub_account" className="cursor-pointer">
              Is a sub-account
            </Label>
          </div>
          {formData.is_sub_account && (
            <Select
              value={formData.parent_id || "none"}
              onValueChange={(value) =>
                setFormData({ ...formData, parent_id: value === "none" ? "" : value })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select parent account..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Select parent —</SelectItem>
                {parentCandidates.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} - {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </Section>

      {mode === "create" && (
        <Section title="Opening Balance">
          <div className="space-y-2 max-w-md">
            <Label htmlFor="opening_balance">Opening Balance (Initial Setup)</Label>
            <Input
              id="opening_balance"
              type="number"
              step="0.01"
              value={formData.opening_balance}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  opening_balance: parseFloat(e.target.value) || 0,
                })
              }
            />
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              For initial setup only. Should be converted to an Opening Balance Journal Entry via the migration tool for proper double-entry accounting.
            </p>
          </div>
        </Section>
      )}

      {mode === "edit" && account && (
        <Section title="Account Balance">
          <div className="space-y-2 max-w-md">
            <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Opening Balance:</span>
                <span className="font-medium">
                  {(account.opening_balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">JE Movements:</span>
                <span className="font-medium">
                  {(account.current_balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
              <div className="flex justify-between border-t pt-1 mt-1">
                <span className="font-medium">Effective Balance:</span>
                <span className="font-bold">
                  {rpcBalance(account.id, account.opening_balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <BookOpen className="h-3 w-3" />
              Balances are derived from journal entries. To adjust, post a journal entry.
            </p>
          </div>
        </Section>
      )}
    </RecordFormShell>
  );
}