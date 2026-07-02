import { useDocumentRecord } from "@/design-system";
import type { Expense } from "@/hooks/useExpenses";

/**
 * useExpenseRecord — canonical single-record fetch for the Expense peek
 * sheet. Mirrors `useBillRecord` / `useVendorCreditNoteRecord` so the
 * whole Purchases surface shares one fetch shape.
 */
export type ExpenseRecord = Expense & {
  journal_entry_id?: string | null;
  payment_account?: { code: string; name: string } | null;
  account?: { code: string; name: string } | null;
};

export function useExpenseRecord(id: string | null | undefined) {
  return useDocumentRecord<ExpenseRecord>({
    table: "expenses",
    select:
      "*, category:expense_categories(id, name, color, account_id), vendor:contacts(name, email), payment_account:accounts!expenses_payment_account_id_fkey(code, name), account:accounts!expenses_account_id_fkey(code, name)",
    id,
    entityLabel: "Expense",
  });
}
