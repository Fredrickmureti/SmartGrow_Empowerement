/**
 * expenseView — the one description of an Expense.
 *
 * Mirrors `invoiceView` / `billView`: the peek sheet consumes this builder
 * so status vocabulary, detail fields and totals live in one place.
 */
import { useMemo } from "react";
import { format } from "date-fns";

import type { DocumentRecordView } from "@/design-system/records";
import { Section } from "@/design-system";
import { describeExpenseSettlement } from "@/lib/finance/expenseCommands";
import type { ExpenseRecord } from "./useExpenseRecord";
import { useExpenseRecord } from "./useExpenseRecord";

function fmt(v?: string | null) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

interface Result {
  record: ExpenseRecord | null;
  loading: boolean;
  error: string | null;
  view: DocumentRecordView;
}

const PAYER_LABEL: Record<string, string> = {
  company: "Company cash or bank",
  company_card: "Company card",
  employee: "Employee out of pocket",
};

/** Lifecycle stamps the server owns — the browser never writes these. */
const LIFECYCLE_STEPS: { column: string; title: string }[] = [
  { column: "submitted_at", title: "Submitted for approval" },
  { column: "approved_at", title: "Approved" },
  { column: "voided_at", title: "Voided" },
];


export function useExpenseView(
  id: string | null | undefined,
  formatCurrency: (v: number, currency?: string) => string,
): Result {
  const { record, loading, error } = useExpenseRecord(id);

  const view = useMemo<DocumentRecordView>(() => {
    const cur = record?.currency || undefined;
    const total = (record?.amount ?? 0) + (record?.tax_amount ?? 0);
    const raw = (record ?? {}) as Record<string, unknown>;
    const str = (k: string) => {
      const v = raw[k];
      return typeof v === "string" && v ? v : null;
    };
    const num = (k: string) => {
      const v = raw[k];
      return v === null || v === undefined ? null : Number(v);
    };
    const paidBy = str("paid_by") ?? "company";
    const exchangeRate = num("exchange_rate");
    const baseAmount = num("base_amount");
    const isForeign = !!exchangeRate && exchangeRate !== 1;

    return {
      kind: "expense",
      documentId: record?.id,
      eyebrow: "Expense",
      listPath: "/purchases/expenses",
      title: record?.description ?? "Expense",
      status: record?.status,
      loading,
      error,
      notFound: !loading && !error && !record,
      meta: record ? (
        <>
          <span>{record.vendor?.name ?? "No vendor"}</span>
          <span>{fmt(record.expense_date)}</span>
        </>
      ) : undefined,
      totalsRows: record
        ? [
            { label: "Amount", value: formatCurrency(record.amount ?? 0, cur) },
            {
              label: "Tax",
              value: formatCurrency(record.tax_amount ?? 0, cur),
              muted: true,
            },
            {
              label: "Total",
              value: formatCurrency(total, cur),
              emphasized: true,
            },
            ...(isForeign && baseAmount !== null
              ? [
                  {
                    label: "Base equivalent",
                    value: formatCurrency(baseAmount),
                    muted: true,
                  },
                ]
              : []),
          ]
        : undefined,
      totalsFooter: cur
        ? isForeign
          ? `Currency ${cur} · rate ${exchangeRate}`
          : `Currency ${cur}`
        : undefined,
      activityExtra: record
        ? [
            {
              id: "created",
              at: fmt(record.created_at),
              actor: "System",
              title: `Expense recorded — ${formatCurrency(record.amount ?? 0, cur)}`,
            },
            ...LIFECYCLE_STEPS.filter((s) => str(s.column)).map((s) => ({
              id: s.column,
              at: fmt(str(s.column)),
              actor: "System",
              title: s.title,
            })),
            ...(record.journal_entry_id
              ? [
                  {
                    id: "posted",
                    at: fmt(str("approved_at") ?? record.created_at),
                    actor: "System",
                    title: "Posted to the general ledger",
                  },
                ]
              : []),
          ]
        : undefined,
      detailFields: record
        ? [
            { label: "Date", value: fmt(record.expense_date) },
            {
              label: "Category",
              value: record.category ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: record.category.color }}
                  />
                  {record.category.name}
                </span>
              ) : (
                "—"
              ),
            },
            { label: "Vendor", value: record.vendor?.name ?? "—" },
            { label: "Paid by", value: PAYER_LABEL[paidBy] ?? paidBy },
            { label: "Payment method", value: record.payment_method || "—" },
            {
              label: "Paid from",
              value: record.payment_account
                ? `${record.payment_account.code} — ${record.payment_account.name}`
                : paidBy === "employee"
                  ? "Employee reimbursements payable"
                  : "Resolved at posting",
            },
            {
              label: "Expense account",
              value: record.account
                ? `${record.account.code} — ${record.account.name}`
                : "Default",
            },
            {
              label: "Tax treatment",
              value:
                str("tax_treatment") === "non_recoverable"
                  ? "Non-recoverable (folded into cost)"
                  : "Recoverable",
            },
            { label: "Reference", value: record.reference || "—" },
            { label: "Billable", value: record.is_billable ? "Yes" : "No" },
          ]
        : undefined,

      extraSections: record?.receipt_url ? (
        <Section title="Receipt">
          <a
            href={record.receipt_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            View receipt
          </a>
        </Section>
      ) : undefined,
    };
  }, [record, loading, error, formatCurrency]);

  return { record, loading, error, view };
}
