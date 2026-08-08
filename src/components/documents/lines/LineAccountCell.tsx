/**
 * LineAccountCell — purchases-side parity for the product form's
 * inheritance-aware GL account field (ADR 0122, P2).
 *
 * Bill and purchase-order lines already carry an `account_id` override in the
 * data model, but no form ever showed which account the line would actually
 * post to. The operator had to trust an invisible ladder. This cell names the
 * effective account and the tier it came from, exactly like
 * `ProductAccountSelector` does on the product form:
 *
 *   Override → Product → Category "…" → Vendor default → Company default
 *
 * Presentation only: resolution mirrors `resolveBillLineAccounts` /
 * `resolve_product_account_override`; nothing here changes how postings are
 * computed at confirm time.
 */
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCcw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAccounts } from "@/hooks/useAccounts";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useCategoryAccounts } from "@/hooks/useCategoryAccounts";
import { resolveCategoryAccount } from "@/lib/productCategoryAccounts";
import type { ProductAccountInfo } from "@/lib/resolveProductAccounts";

interface Props {
  /** Line-level override, `null` when the line inherits. */
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  /** Product the line points at, if any (free-text lines pass null). */
  product?: ProductAccountInfo | null;
  /** Vendor's own default expense account, the tier above company default. */
  vendorExpenseAccountId?: string | null;
  disabled?: boolean;
}

type Tier = "override" | "product" | "category" | "vendor" | "company" | "none";

const TIER_LABEL: Record<Exclude<Tier, "override" | "none">, string> = {
  product: "From product",
  category: "From category",
  vendor: "From vendor",
  company: "Default",
};

export function LineAccountCell({
  value,
  onChange,
  product,
  vendorExpenseAccountId,
  disabled,
}: Props) {
  const { accounts } = useAccounts();
  const { accounts: defaults, isReady } = useDefaultAccounts();
  const { categories } = useCategoryAccounts();
  const [open, setOpen] = useState(false);

  // Inventory-tracked purchases debit the inventory asset; everything else
  // hits the expense ladder. Same branch as resolveBillLineAccounts.
  const tracked = !!product?.track_inventory;

  const resolution = useMemo((): { accountId: string | null; tier: Tier; categoryName?: string | null } => {
    if (value) return { accountId: value, tier: "override" };

    if (tracked) {
      if (product?.inventory_account_id)
        return { accountId: product.inventory_account_id, tier: "product" };
      const cat = resolveCategoryAccount(categories, product?.category_id, "inventory_account_id");
      if (cat.accountId)
        return { accountId: cat.accountId, tier: "category", categoryName: cat.categoryName };
      return { accountId: defaults.inventory_account_id ?? null, tier: "company" };
    }

    if (product?.purchase_account_id)
      return { accountId: product.purchase_account_id, tier: "product" };
    const cat = resolveCategoryAccount(categories, product?.category_id, "purchase_account_id");
    if (cat.accountId)
      return { accountId: cat.accountId, tier: "category", categoryName: cat.categoryName };
    if (vendorExpenseAccountId)
      return { accountId: vendorExpenseAccountId, tier: "vendor" };
    return { accountId: defaults.operating_expenses_id ?? null, tier: "company" };
  }, [value, tracked, product, categories, defaults, vendorExpenseAccountId]);

  const account = resolution.accountId
    ? accounts.find((a) => a.id === resolution.accountId)
    : undefined;
  const accountLabel = account ? `${account.code} — ${account.name}` : undefined;

  const selectable = accounts.filter(
    (a) => a.is_active && (tracked ? a.account_type === "asset" : a.account_type === "expense"),
  );

  const unmapped = isReady && !resolution.accountId;
  const tierText =
    resolution.tier === "override"
      ? "Override"
      : resolution.tier === "category"
        ? `From category${resolution.categoryName ? ` "${resolution.categoryName}"` : ""}`
        : TIER_LABEL[resolution.tier as Exclude<Tier, "override" | "none">];

  if (!open) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Posts to</span>
        {unmapped ? (
          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-500">
            <AlertTriangle className="h-3.5 w-3.5" />
            No account mapped — this line will fail to post
          </span>
        ) : (
          <span
            className={
              resolution.tier === "override"
                ? "truncate font-medium"
                : "truncate text-muted-foreground"
            }
          >
            {accountLabel ?? "—"}
          </span>
        )}
        <Badge variant={resolution.tier === "override" ? "default" : "secondary"}>
          {tierText}
        </Badge>
        {!disabled && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={() => setOpen(true)}
          >
            Change
          </Button>
        )}
        {!disabled && value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2"
            onClick={() => onChange(null)}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Reset
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Posts to</span>
      <Select
        value={value ?? "inherit"}
        onValueChange={(next) => {
          onChange(next === "inherit" ? null : next);
          setOpen(false);
        }}
        disabled={disabled}
      >
        <SelectTrigger className="h-8 w-[280px]">
          <SelectValue placeholder="Select account" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            {accountLabel ? `Inherit (${accountLabel})` : "Inherit (no account mapped)"}
          </SelectItem>
          {selectable.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.code} — {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2"
        onClick={() => setOpen(false)}
      >
        Cancel
      </Button>
    </div>
  );
}
