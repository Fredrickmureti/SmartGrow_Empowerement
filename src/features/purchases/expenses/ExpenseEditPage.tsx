/**
 * ExpenseEditPage — full-page edit route at `/purchases/expenses/:id/edit`.
 *
 * Replaces the inline `<Dialog>` edit surface previously in
 * `src/pages/Expenses.tsx`. Uses the same shared field body as
 * `ExpenseCreatePage` so create and edit stay pixel-identical.
 *
 * Guard-rail: only `pending` expenses are editable (matches the
 * dropdown gate in the list view — `handleOpenDialog` was only wired
 * from the "Edit" menu item, itself gated on `status === "pending"`).
 * The page surfaces a clear error state for any other status so a
 * stale deep-link can't sneak an update through.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  ErrorState,
  LoadingState,
  RecordFormShell,
  useRecordFormSubmit,
} from "@/design-system";
import { useToast } from "@/hooks/use-toast";
import { useContacts } from "@/hooks/useContacts";
import { useCurrency } from "@/hooks/useCurrency";
import { useDefaultAccounts } from "@/hooks/useDefaultAccounts";
import { isExpenseEditable } from "@/lib/finance/expenseCommands";
import { useExpensesPaginated } from "@/hooks/useExpensesPaginated";
import { useExpenseRecord } from "./useExpenseRecord";
import {
  ExpenseFormFields,
  makeEmptyExpenseForm,
  type ExpenseFormValues,
} from "./ExpenseFormFields";
import { usePaymentAccounts } from "./usePaymentAccounts";

export default function ExpenseEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const { baseCurrency } = useCurrency();
  const { contacts } = useContacts();
  const { accounts: defaultAccounts } = useDefaultAccounts();
  const paymentAccounts = usePaymentAccounts();

  const { categories, updateExpense } = useExpensesPaginated({});
  const { record, loading: isLoading, error } = useExpenseRecord(id);

  const vendors = useMemo(
    () =>
      contacts
        .filter((c) => c.type === "supplier" || c.type === "both")
        .map((c) => ({ id: c.id, name: c.name })),
    [contacts],
  );

  const [form, setForm] = useState<ExpenseFormValues>(() =>
    makeEmptyExpenseForm(baseCurrency),
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!record || hydrated) return;
    setForm({
      expense_date: record.expense_date,
      amount: Number(record.amount) || 0,
      tax_amount: Number(record.tax_amount) || 0,
      tax_rate_id:
        (record as { tax_rate_id?: string | null }).tax_rate_id ?? null,
      tax_treatment:
        ((record as { tax_treatment?: string | null }).tax_treatment as
          | "recoverable"
          | "non_recoverable"
          | undefined) ?? "recoverable",
      description: record.description ?? "",
      reference: record.reference ?? "",
      category_id: record.category_id ?? "",
      vendor_id: record.vendor_id ?? "",
      is_billable: !!record.is_billable,
      receipt_url: record.receipt_url ?? null,
      currency: record.currency || baseCurrency,
      payment_method: record.payment_method || "cash",
      payment_account_id: record.payment_account_id ?? "",
      project_id: (record as { project_id?: string | null }).project_id ?? null,
      department_id:
        (record as { department_id?: string | null }).department_id ?? null,
      analytic_account_id:
        (record as { analytic_account_id?: string | null })
          .analytic_account_id ?? null,
    });
    setHydrated(true);
  }, [record, hydrated, baseCurrency]);

  const patch = (p: Partial<ExpenseFormValues>) =>
    setForm((prev) => ({ ...prev, ...p }));

  const isAPSelected = !!(
    form.payment_account_id &&
    defaultAccounts.accounts_payable_id &&
    form.payment_account_id === defaultAccounts.accounts_payable_id
  );

  const submit = useRecordFormSubmit<void>({
    entityLabel: "Expense",
    mode: "edit",
    redirectTo: () => "/purchases/expenses",
  });

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!id) return;

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

    await submit.run(async () => {
      await updateExpense(id, {
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
      } as Parameters<typeof updateExpense>[1]);
    });
  };

  if (isLoading) {
    return <LoadingState />;
  }
  if (error || !record) {
    return (
      <ErrorState
        title="Expense not found"
        description="This expense may have been deleted or you no longer have access."
        onRetry={() => navigate("/purchases/expenses")}
      />
    );
  }
  if (!isExpenseEditable(record.status)) {
    return (
      <ErrorState
        title="This expense can no longer be edited"
        description={`Only unposted expenses can be edited. This expense is ${record.status}. Void it first if you need to change the amount.`}
        onRetry={() => navigate("/purchases/expenses")}
      />
    );
  }

  return (
    <RecordFormShell
      mode="edit"
      entityLabel="Expense"
      recordRef={record.reference || record.description}
      cancelHref="/purchases/expenses"
      onCancel={() => navigate("/purchases/expenses")}
      onSubmit={onSubmit}
      isSubmitting={submit.isSubmitting}
      submitDisabled={
        !form.description || !form.amount || !form.payment_account_id
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
        entityId={record.id}
        disabled={submit.isSubmitting}
      />
    </RecordFormShell>
  );
}
