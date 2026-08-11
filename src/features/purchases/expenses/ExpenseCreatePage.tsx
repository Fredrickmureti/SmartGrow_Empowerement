/**
 * ExpenseCreatePage — full-page create route at `/purchases/expenses/new`.
 *
 * Replaces the inline `<Dialog>` create surface previously in
 * `src/pages/Expenses.tsx`. Composed on the platform's ONE approved
 * create/edit scaffold (`RecordFormShell` + `useRecordFormSubmit`),
 * matching every other Purchases/Sales record form.
 *
 * Preserves every behavior from the retired dialog:
 *   - Default account (AP) detection + linked-bill autoflow via
 *     `useExpensesPaginated.createExpense` (which internally handles
 *     the AP → bill fanout and returns `{ data, billCreated }`)
 *   - Category → `account_id` auto-resolution
 *   - AP-selected → supplier-required validation
 *   - Deep-link prefill: `?contact_id=…&project_id=…`
 */
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { RecordFormShell, useRecordFormSubmit } from "@/design-system";
import { useToast } from "@/hooks/use-toast";
import { useContacts } from "@/hooks/useContacts";
import { useCurrency } from "@/hooks/useCurrency";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { useExpensesPaginated } from "@/hooks/useExpensesPaginated";
import {
  ExpenseFormFields,
  makeEmptyExpenseForm,
  type ExpenseFormValues,
} from "./ExpenseFormFields";
import { usePaymentAccounts } from "./usePaymentAccounts";

export default function ExpenseCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const { baseCurrency } = useCurrency();
  const { contacts } = useContacts();
  const { accounts: defaultAccounts } = useDefaultAccounts();
  const paymentAccounts = usePaymentAccounts();

  const { categories, createExpense } = useExpensesPaginated({});

  const vendors = useMemo(
    () =>
      contacts
        .filter((c) => c.type === "supplier" || c.type === "both")
        .map((c) => ({ id: c.id, name: c.name })),
    [contacts],
  );

  const [form, setForm] = useState<ExpenseFormValues>(() => {
    const empty = makeEmptyExpenseForm(baseCurrency);
    const prefillVendor = searchParams.get("contact_id");
    const prefillProject = searchParams.get("project_id");
    return {
      ...empty,
      ...(prefillVendor ? { vendor_id: prefillVendor } : {}),
      ...(prefillProject ? { project_id: prefillProject } : {}),
    };
  });

  const patch = (p: Partial<ExpenseFormValues>) =>
    setForm((prev) => ({ ...prev, ...p }));

  const isAPSelected = !!(
    form.payment_account_id &&
    defaultAccounts.accounts_payable_id &&
    form.payment_account_id === defaultAccounts.accounts_payable_id
  );

  const submit = useRecordFormSubmit<{ data: { id: string }; billCreated: boolean }>({
    entityLabel: "Expense",
    mode: "create",
    redirectTo: () => "/purchases/expenses",
  });

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (form.paid_by === "employee" && !form.employee_id) {
      toast({
        title: "Employee required",
        description:
          "An out-of-pocket expense must name the employee who will be reimbursed.",
        variant: "destructive",
      });
      return;
    }

    if (isAPSelected && !form.vendor_id) {
      toast({
        title: "Vendor required",
        description:
          "Paying from Accounts Payable requires a supplier so a vendor bill can be created.",
        variant: "destructive",
      });
      return;
    }

    const selectedCategory = form.category_id
      ? categories.find((c) => c.id === form.category_id)
      : null;

    await submit.run(() =>
      createExpense({
        paid_by: form.paid_by,
        employee_id: form.paid_by === "employee" ? form.employee_id : null,
        expense_date: form.expense_date,
        amount: form.amount,
        tax_rate_id: form.tax_rate_id,
        tax_treatment: form.tax_treatment,
        description: form.description,
        reference: form.reference || null,
        category_id: form.category_id || null,
        vendor_id: form.vendor_id || null,
        is_billable: form.is_billable,
        currency: form.currency || baseCurrency,
        receipt_url: form.receipt_url || null,
        account_id: selectedCategory?.account_id || null,
        payment_method: form.payment_method || "cash",
        payment_account_id: form.payment_account_id || null,
        project_id: form.project_id,
        department_id: form.department_id,
        analytic_account_id: form.analytic_account_id,
      } as Parameters<typeof createExpense>[0]),
    );
  };

  return (
    <RecordFormShell
      mode="create"
      entityLabel="Expense"
      cancelHref="/purchases/expenses"
      onCancel={() => navigate("/purchases/expenses")}
      onSubmit={onSubmit}
      isSubmitting={submit.isSubmitting}
      submitDisabled={
        !form.description ||
        !form.amount ||
        (form.paid_by === "company" && !form.payment_account_id) ||
        (form.paid_by === "employee" && !form.employee_id)
      }
    >
      <ExpenseFormFields
        value={form}
        onChange={patch}
        categories={categories}
        vendors={vendors}
        paymentAccounts={paymentAccounts}
        baseCurrency={baseCurrency}
        isAPSelected={isAPSelected}
        entityId={null}
        disabled={submit.isSubmitting}
      />
    </RecordFormShell>
  );
}
