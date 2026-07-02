/**
 * ExpensePeekSheet — standard peek surface for one Expense on
 * `/purchases/expenses?peek=<id>`. Retires `ExpenseDetailDialog`.
 * Mirrors `BillPeekSheet` and every other Purchases peek sheet so the
 * whole ERP presents business records with the same shell.
 */
import { format } from "date-fns";
import {
  Section,
  StatusBadge,
  DocumentActivityPanel,
  DocumentPeekShell,
  DocumentTotalsPanel,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { ExternalLink, XCircle } from "lucide-react";
import { useCurrency } from "@/hooks/useCurrency";
import { useExpenseRecord } from "./useExpenseRecord";

const TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  pending: "warning",
  approved: "success",
  paid: "info",
  rejected: "danger",
  voided: "neutral",
};

const label = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const fmt = (v?: string | null) => {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
};

interface Props {
  expenseId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Optional void handler for approved/paid expenses. */
  onVoid?: (id: string) => void;
}

export function ExpensePeekSheet({ expenseId, onOpenChange, onVoid }: Props) {
  const { record, loading, error } = useExpenseRecord(expenseId);
  const { formatCurrency, baseCurrency } = useCurrency();
  const cur = record?.currency || baseCurrency;
  const isLocked =
    record?.status === "approved" || record?.status === "paid";

  return (
    <DocumentPeekShell
      open={!!expenseId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load expense"
      title={
        loading
          ? "Loading expense…"
          : record
            ? record.description
            : "Expense"
      }
      description={
        record ? (
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={TONE[record.status] ?? "neutral"}>
              {label(record.status)}
            </StatusBadge>
            <span className="text-muted-foreground">
              {record.vendor?.name ?? "No vendor"}
            </span>
          </span>
        ) : undefined
      }
    >
      {record && (
        <div className="space-y-5">
          <Section title="Details">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Date</dt>
                <dd className="mt-0.5">{fmt(record.expense_date)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Category</dt>
                <dd className="mt-0.5">
                  {record.category ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: record.category.color }}
                      />
                      {record.category.name}
                    </span>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Vendor</dt>
                <dd className="mt-0.5">{record.vendor?.name ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Payment method</dt>
                <dd className="mt-0.5">{record.payment_method || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Paid from</dt>
                <dd className="mt-0.5">
                  {record.payment_account
                    ? `${record.payment_account.code} — ${record.payment_account.name}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Expense account</dt>
                <dd className="mt-0.5">
                  {record.account
                    ? `${record.account.code} — ${record.account.name}`
                    : "Default"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Reference</dt>
                <dd className="mt-0.5">{record.reference || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Billable</dt>
                <dd className="mt-0.5">{record.is_billable ? "Yes" : "No"}</dd>
              </div>
            </dl>
          </Section>

          <Section title="Totals">
            <DocumentTotalsPanel
              rows={[
                { label: "Amount", value: formatCurrency(record.amount ?? 0, cur) },
                {
                  label: "Tax",
                  value: formatCurrency(record.tax_amount ?? 0, cur),
                  muted: true,
                },
                {
                  label: "Total",
                  value: formatCurrency(
                    (record.amount ?? 0) + (record.tax_amount ?? 0),
                    cur,
                  ),
                  emphasized: true,
                },
              ]}
              footer={`Currency ${cur}`}
            />
          </Section>

          {record.receipt_url && (
            <Section title="Receipt">
              <a
                href={record.receipt_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                View receipt <ExternalLink className="h-3 w-3" />
              </a>
            </Section>
          )}

          <Section title="Activity">
            <DocumentActivityPanel
              entries={[
                {
                  id: "created",
                  at: fmt(record.created_at),
                  actor: "System",
                  title: `Expense recorded — ${formatCurrency(record.amount ?? 0, cur)}`,
                },
              ]}
            />
          </Section>

          {onVoid && isLocked && record.status !== ("voided" as unknown as typeof record.status) && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={() => {
                  onVoid(record.id);
                  onOpenChange(false);
                }}
                className="text-destructive hover:text-destructive"
              >
                <XCircle className="mr-2 h-4 w-4" />
                Void expense
              </Button>
            </div>
          )}
        </div>
      )}
    </DocumentPeekShell>
  );
}

export default ExpensePeekSheet;
