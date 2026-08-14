/**
 * Per-product GL overrides. Resolution order is product → category → company
 * default (ADR 0122); posting uses `resolve_product_gl_account` server-side.
 * This section only edits the product tier.
 */
import { DollarSign } from "lucide-react";
import { Section, FieldGrid } from "@/design-system";
import { ProductAccountSelector } from "@/components/products/ProductAccountSelector";
import type {
  CategoryAccountField,
  CategoryAccountResolution,
} from "@/lib/productCategoryAccounts";
import type { ProductFormPatch, ProductFormValues } from "../formState";

export interface GlAccountsSectionProps {
  values: ProductFormValues;
  onChange: ProductFormPatch;
  /** Category tier of the ladder, for display of the inherited default. */
  categoryAccount: (field: CategoryAccountField) => CategoryAccountResolution;
  disabled?: boolean;
}

export function GlAccountsSection({
  values,
  onChange,
  categoryAccount,
  disabled,
}: GlAccountsSectionProps) {
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground" /> Default GL accounts
        </span>
      }
      description="Optional per-product overrides. System defaults are used when blank."
    >
      <FieldGrid columns={2}>
        <ProductAccountSelector
          label="Sales revenue account"
          value={values.sales_account_id}
          onChange={(v) => onChange({ sales_account_id: v })}
          accountType="income"
          defaultKey="sales_revenue_id"
          categoryDefault={categoryAccount("sales_account_id")}
          helpText="Revenue account credited on sale"
          disabled={disabled}
        />
        <ProductAccountSelector
          label="Purchase / expense account"
          value={values.purchase_account_id}
          onChange={(v) => onChange({ purchase_account_id: v })}
          accountType="expense"
          defaultKey="operating_expenses_id"
          categoryDefault={categoryAccount("purchase_account_id")}
          helpText="Expense account debited when this item appears on a bill"
          disabled={disabled}
        />
        {(values.type === "product" || values.track_inventory) && (
          <>
            <ProductAccountSelector
              label="COGS account"
              value={values.cogs_account_id}
              onChange={(v) => onChange({ cogs_account_id: v })}
              accountType="expense"
              defaultKey="cost_of_goods_sold_id"
              categoryDefault={categoryAccount("cogs_account_id")}
              helpText="Cost of Goods Sold debited on sale"
              disabled={disabled}
            />
            <ProductAccountSelector
              label="Inventory account"
              value={values.inventory_account_id}
              onChange={(v) => onChange({ inventory_account_id: v })}
              accountType="asset"
              defaultKey="inventory_account_id"
              categoryDefault={categoryAccount("inventory_account_id")}
              helpText="Inventory asset account for stock valuation"
              disabled={disabled}
            />
          </>
        )}
      </FieldGrid>
    </Section>
  );
}

export default GlAccountsSection;
