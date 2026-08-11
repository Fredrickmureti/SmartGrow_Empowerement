/**
 * ExpenseFormFields — the single shared form body used by both
 * `ExpenseCreatePage` and `ExpenseEditPage`. Kept as a controlled
 * component (parent owns `value` + `onChange`) so the create and edit
 * routes can each layer their own submit / redirect logic on top via
 * `useRecordFormSubmit` without duplicating field markup.
 *
 * Preserves every field + rule from the retired inline dialog in
 * `src/pages/Expenses.tsx`:
 *   - AP-selected payment account triggers a linked-bill notice
 *   - AP requires a supplier
 *   - Category-without-GL warning + default-to-Operating-Expenses info
 *   - Receipt upload
 *   - Project analytics picker
 *   - Custom fields section
 */
import { AlertTriangle, Info } from "lucide-react";
import { format } from "date-fns";

import { Section } from "@/design-system";
import { FieldGrid } from "@/design-system";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CurrencySelect } from "@/components/common/CurrencySelect";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { CapabilityGate } from "@/components/apps/CapabilityGate";
import { ReceiptUpload } from "@/components/expenses/ReceiptUpload";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import type { ExpenseCategory } from "@/hooks/useExpenses";
import { useTaxRates } from "@/hooks/useTaxRates";
import { useDepartments } from "@/hooks/useDepartments";
import { useAnalyticAccounts } from "@/hooks/useAnalyticAccounts";

export type ExpenseTaxTreatment = "recoverable" | "non_recoverable";

export interface ExpenseFormValues {
  expense_date: string;
  amount: number;
  /** Server-computed from `tax_rate_id`; read-only in the UI. */
  tax_amount: number;
  tax_rate_id: string | null;
  tax_treatment: ExpenseTaxTreatment;
  description: string;
  reference: string;
  category_id: string;
  vendor_id: string;
  is_billable: boolean;
  receipt_url: string | null;
  currency: string;
  payment_method: string;
  payment_account_id: string;
  project_id: string | null;
  department_id: string | null;
  analytic_account_id: string | null;
}

export interface PaymentAccountOption {
  id: string;
  code: string;
  name: string;
}

export interface VendorOption {
  id: string;
  name: string;
}

interface Props {
  value: ExpenseFormValues;
  onChange: (patch: Partial<ExpenseFormValues>) => void;
  categories: ExpenseCategory[];
  vendors: VendorOption[];
  paymentAccounts: PaymentAccountOption[];
  baseCurrency: string;
  /** Whether the currently-selected payment account is the AP account. */
  isAPSelected: boolean;
  /** For `<CustomFieldsSection entityId=…>`. `null` in create mode. */
  entityId: string | null;
  disabled?: boolean;
}

export function makeEmptyExpenseForm(baseCurrency: string): ExpenseFormValues {
  return {
    expense_date: format(new Date(), "yyyy-MM-dd"),
    amount: 0,
    tax_amount: 0,
    tax_rate_id: null,
    tax_treatment: "recoverable",
    description: "",
    reference: "",
    category_id: "",
    vendor_id: "",
    is_billable: false,
    receipt_url: null,
    currency: baseCurrency,
    payment_method: "cash",
    payment_account_id: "",
    project_id: null,
    department_id: null,
    analytic_account_id: null,
  };
}

export function ExpenseFormFields({
  value,
  onChange,
  categories,
  vendors,
  paymentAccounts,
  baseCurrency,
  isAPSelected,
  entityId,
  disabled,
}: Props) {
  const selectedCategory = value.category_id
    ? categories.find((c) => c.id === value.category_id) ?? null
    : null;

  return (
    <>
      <Section
        title="Expense details"
        description="Date, amount, category, and supplier for this expense."
      >
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="expense_date">Date *</Label>
            <Input
              id="expense_date"
              type="date"
              value={value.expense_date}
              onChange={(e) => onChange({ expense_date: e.target.value })}
              disabled={disabled}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="amount">Amount *</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              min="0"
              value={value.amount}
              onChange={(e) =>
                onChange({ amount: parseFloat(e.target.value) || 0 })
              }
              disabled={disabled}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tax_amount">Tax amount</Label>
            <Input
              id="tax_amount"
              type="number"
              step="0.01"
              min="0"
              value={value.tax_amount}
              onChange={(e) =>
                onChange({ tax_amount: parseFloat(e.target.value) || 0 })
              }
              disabled={disabled}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="currency">Currency</Label>
            <CurrencySelect
              value={value.currency || baseCurrency}
              onChange={(c) => onChange({ currency: c })}
            />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="description">Description *</Label>
            <Input
              id="description"
              value={value.description}
              onChange={(e) => onChange({ description: e.target.value })}
              disabled={disabled}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="category">Category</Label>
            <Select
              value={value.category_id}
              onValueChange={(v) => onChange({ category_id: v })}
              disabled={disabled}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    <span className="flex items-center gap-2">
                      {cat.name}
                      {!cat.account_id && (
                        <span className="text-xs text-amber-500">⚠ No GL</span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedCategory && !selectedCategory.account_id && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                ⚠ This category has no GL account mapped. Expenses will default
                to Operating Expenses.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="vendor">Supplier</Label>
            <Select
              value={value.vendor_id}
              onValueChange={(v) => onChange({ vendor_id: v })}
              disabled={disabled}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select supplier" />
              </SelectTrigger>
              <SelectContent>
                {vendors.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="payment_account">Paid from account *</Label>
            <Select
              value={value.payment_account_id}
              onValueChange={(v) => onChange({ payment_account_id: v })}
              disabled={disabled}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select payment account" />
              </SelectTrigger>
              <SelectContent>
                {paymentAccounts.map((acc) => (
                  <SelectItem key={acc.id} value={acc.id}>
                    {acc.code} — {acc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Ledger account to credit (Cash, Bank, Accounts Payable…).
            </p>
            {isAPSelected && (
              <div className="mt-2 space-y-2">
                <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-2.5 dark:border-blue-800 dark:bg-blue-950">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
                  <p className="text-xs text-blue-700 dark:text-blue-300">
                    A vendor bill will be created automatically and appear in{" "}
                    <strong>Purchases → Bills</strong> and{" "}
                    <strong>Finance → Accounts Payable</strong>.
                  </p>
                </div>
                {!value.vendor_id && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-800 dark:bg-amber-950">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      <strong>Supplier required.</strong> Select a supplier
                      above to create a payable expense.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="reference">Reference</Label>
            <Input
              id="reference"
              value={value.reference}
              onChange={(e) => onChange({ reference: e.target.value })}
              placeholder="Receipt #, invoice #, etc."
              disabled={disabled}
            />
          </div>
        </FieldGrid>
      </Section>

      <CapabilityGate cap="projects.analytic-tagging">
        <Section
          title="Analytics"
          description="Optional project link for cost-to-profitability tracking."
        >
          <ProjectPicker
            value={value.project_id}
            onChange={(id) => onChange({ project_id: id })}
            helperText="Optional — links this expense's cost to project profitability."
          />
        </Section>
      </CapabilityGate>

      <Section title="Receipt">
        <ReceiptUpload
          currentReceiptUrl={value.receipt_url}
          onUploadComplete={(url) => onChange({ receipt_url: url })}
          onRemove={() => onChange({ receipt_url: null })}
        />
      </Section>

      <Section title="Additional fields">
        <CustomFieldsSection
          entityType="expense"
          entityId={entityId}
          formValues={value}
          disabled={disabled}
        />
      </Section>
    </>
  );
}
