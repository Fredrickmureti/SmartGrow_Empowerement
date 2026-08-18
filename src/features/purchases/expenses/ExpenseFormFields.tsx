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
import { ExchangeRatePanel } from "@/components/finance/ExchangeRatePanel";
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { CapabilityGate } from "@/components/apps/CapabilityGate";
import { ReceiptUpload } from "@/components/expenses/ReceiptUpload";
import { ExpenseReceipts } from "@/components/expenses/ExpenseReceipts";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import type { ExpenseCategory } from "@/hooks/useExpenses";
import { useTaxRates } from "@/hooks/useTaxRates";
import { useDepartments } from "@/hooks/useDepartments";
import { useAnalyticAccounts } from "@/hooks/useAnalyticAccounts";
import { useEmployees } from "@/hooks/useEmployees";


export type ExpenseTaxTreatment = "recoverable" | "non_recoverable";

/**
 * Who funded the outflow. This is the first question the capture flow
 * asks because it decides the credit side of the posting:
 *   company      → cash / bank / mobile money (or an explicitly chosen account)
 *   company_card → the card clearing account
 *   employee     → the employee reimbursements payable, settled later
 * `post_expense_gl` resolves the account server-side when none is picked.
 */
export type ExpensePaidBy = "company" | "company_card" | "employee";

export interface ExpenseFormValues {
  paid_by: ExpensePaidBy;
  employee_id: string | null;
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

const PAYER_OPTIONS: { value: ExpensePaidBy; label: string; hint: string }[] = [
  {
    value: "company",
    label: "Company cash or bank",
    hint: "Money left a company account directly.",
  },
  {
    value: "company_card",
    label: "Company card",
    hint: "Settled later against the card clearing account.",
  },
  {
    value: "employee",
    label: "Employee out of pocket",
    hint: "Creates a reimbursement owed to the employee.",
  },
];

const PAYMENT_METHODS: { value: string; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "petty_cash", label: "Petty cash" },
  { value: "bank", label: "Bank transfer" },
  { value: "mobile_money", label: "Mobile money" },
  { value: "cheque", label: "Cheque" },
];

export function makeEmptyExpenseForm(baseCurrency: string): ExpenseFormValues {
  return {
    paid_by: "company",
    employee_id: null,
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
  const { activeTaxRates } = useTaxRates();
  const { departments } = useDepartments();
  const { activeAccounts: analyticAccounts } = useAnalyticAccounts();
  const { employees, isLoading: employeesLoading } = useEmployees({
    enabled: value.paid_by === "employee",
  });

  const payerHint =
    PAYER_OPTIONS.find((o) => o.value === value.paid_by)?.hint ?? "";


  const selectedCategory = value.category_id
    ? categories.find((c) => c.id === value.category_id) ?? null
    : null;

  const selectedTaxRate = value.tax_rate_id
    ? activeTaxRates.find((t) => t.id === value.tax_rate_id) ?? null
    : null;

  // Preview only — `_expenses_derive_base_amount` is authoritative.
  const previewTax = selectedTaxRate
    ? selectedTaxRate.tax_type === "fixed"
      ? Number(selectedTaxRate.fixed_amount) || 0
      : selectedTaxRate.is_inclusive
        ? (Number(value.amount) || 0) -
          (Number(value.amount) || 0) / (1 + Number(selectedTaxRate.rate) / 100)
        : ((Number(value.amount) || 0) * Number(selectedTaxRate.rate)) / 100
    : Number(value.tax_amount) || 0;


  return (
    <>
      <Section
        title="Who paid?"
        description="The funding source decides which account is credited when this expense posts. Answer this first."
      >
        <FieldGrid columns={2}>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="paid_by">Funded by *</Label>
            <Select
              value={value.paid_by}
              onValueChange={(v) =>
                onChange({
                  paid_by: v as ExpensePaidBy,
                  // Non-company payers never credit a hand-picked account:
                  // `post_expense_gl` resolves the card clearing / employee
                  // payable account itself.
                  payment_account_id: v === "company" ? value.payment_account_id : "",
                  employee_id: v === "employee" ? value.employee_id : null,
                })
              }
              disabled={disabled}
            >
              <SelectTrigger id="paid_by">
                <SelectValue placeholder="Select payer" />
              </SelectTrigger>
              <SelectContent>
                {PAYER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{payerHint}</p>
          </div>

          {value.paid_by === "employee" && (
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="employee">Employee to reimburse *</Label>
              <Select
                value={value.employee_id ?? ""}
                onValueChange={(v) => onChange({ employee_id: v })}
                disabled={disabled || employeesLoading}
              >
                <SelectTrigger id="employee">
                  <SelectValue
                    placeholder={
                      employeesLoading ? "Loading employees…" : "Select employee"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((emp) => (
                    <SelectItem key={emp.id} value={emp.id}>
                      {emp.first_name} {emp.last_name}
                      {emp.employee_number ? ` — ${emp.employee_number}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-2.5 dark:border-blue-800 dark:bg-blue-950">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
                <p className="text-xs text-blue-700 dark:text-blue-300">
                  Approval credits the employee reimbursements payable. The
                  obligation is discharged once — either through payroll or a
                  direct reimbursement — never both.
                </p>
              </div>
            </div>
          )}

          {value.paid_by === "company" && (
            <div className="space-y-2">
              <Label htmlFor="payment_method">Payment method</Label>
              <Select
                value={value.payment_method || "cash"}
                onValueChange={(v) => onChange({ payment_method: v })}
                disabled={disabled}
              >
                <SelectTrigger id="payment_method">
                  <SelectValue placeholder="Select method" />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </FieldGrid>
      </Section>

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
            <Label htmlFor="tax_rate">Tax rate</Label>
            <Select
              value={value.tax_rate_id ?? "none"}
              onValueChange={(v) =>
                onChange({ tax_rate_id: v === "none" ? null : v })
              }
              disabled={disabled}
            >
              <SelectTrigger id="tax_rate">
                <SelectValue placeholder="No tax" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No tax</SelectItem>
                {activeTaxRates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                    {t.tax_type === "fixed"
                      ? ` (${t.fixed_amount})`
                      : ` (${t.rate}%)`}
                    {t.is_inclusive ? " · inclusive" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Tax of {previewTax.toFixed(2)} — computed on the server from the
              selected rate.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tax_treatment">Tax treatment</Label>
            <Select
              value={value.tax_treatment}
              onValueChange={(v) =>
                onChange({ tax_treatment: v as ExpenseTaxTreatment })
              }
              disabled={disabled || !value.tax_rate_id}
            >
              <SelectTrigger id="tax_treatment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recoverable">
                  Recoverable — claim as input tax
                </SelectItem>
                <SelectItem value="non_recoverable">
                  Non-recoverable — add to expense cost
                </SelectItem>
              </SelectContent>
            </Select>
          </div>


          <div className="space-y-2">
            <Label htmlFor="currency">Currency</Label>
            <CurrencySelect
              value={value.currency || baseCurrency}
              onChange={(c) => onChange({ currency: c })}
              disabled={disabled}
            />
            {/* Same FX seam as every other money document — the rate book is
                shown, never guessed, and never 1:1 (ADR 0136). */}
            <ExchangeRatePanel
              currency={value.currency || baseCurrency}
              onDate={value.expense_date}
              baseHint="This expense is in the base currency — no conversion applies."
              missingHint="Publish or override a rate in the rate book before saving — the expense cannot be valued at parity."
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

          {value.paid_by === "company" ? (
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
          ) : null}


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

      <Section
        title="Cost allocation"
        description="Where this cost belongs. Drives the analytic distribution written when the expense posts."
      >
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="department">Department</Label>
            <Select
              value={value.department_id ?? "none"}
              onValueChange={(v) =>
                onChange({ department_id: v === "none" ? null : v })
              }
              disabled={disabled}
            >
              <SelectTrigger id="department">
                <SelectValue placeholder="No department" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No department</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="analytic_account">Cost center</Label>
            <Select
              value={value.analytic_account_id ?? "none"}
              onValueChange={(v) =>
                onChange({ analytic_account_id: v === "none" ? null : v })
              }
              disabled={disabled}
            >
              <SelectTrigger id="analytic_account">
                <SelectValue placeholder="No cost center" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No cost center</SelectItem>
                {analyticAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code ? `${a.code} — ${a.name}` : a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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


      <Section
        title="Receipt"
        description={
          entityId
            ? "Receipts are stored on the expense's audit trail and locked once it is approved."
            : undefined
        }
      >
        {entityId ? (
          <ExpenseReceipts expenseId={entityId} disabled={disabled} />
        ) : (
          <ReceiptUpload
            currentReceiptUrl={value.receipt_url}
            onUploadComplete={(url) => onChange({ receipt_url: url })}
            onRemove={() => onChange({ receipt_url: null })}
          />
        )}
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
