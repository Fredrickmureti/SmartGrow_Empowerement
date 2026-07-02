/**
 * CustomerPaymentPeekSheet — standard peek for one customer payment.
 * Void / unreconcile / reallocate actions stay in the parent list row menu.
 * Shows allocations sourced from payment_allocations (ADR 0027).
 */
import { format } from "date-fns";
import { Section, StatusBadge } from "@/design-system";
import {
  DocumentActivityPanel,
  DocumentPeekShell,
} from "@/features/sales/record";
import { useCurrency } from "@/hooks/useCurrency";
import type { Payment } from "@/hooks/usePayments";
import { useCustomerPaymentRecord } from "./useCustomerPaymentRecord";

const fmt = (v?: string | null) => { if (!v) return "—"; try { return format(new Date(v), "PP"); } catch { return v; } };
const methodLabel = (m?: string) => (m ?? "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

interface Props { paymentId: string | null; onOpenChange: (o: boolean) => void; }

export function CustomerPaymentPeekSheet({ paymentId, onOpenChange }: Props) {
  const { record, loading, error } = useCustomerPaymentRecord(paymentId);
  const { formatCurrency } = useCurrency();

  const status = (record as any)?.status as string | undefined;
  const allocations: Array<{ amount: number; invoice: { id: string; invoice_number: string; total: number } | null }> =
    ((record as any)?.payment_allocations ?? []).map((a: any) => ({
      amount: Number(a.amount ?? 0),
      invoice: a.invoice ?? null,
    }));
  const allocatedTotal = allocations.reduce((s, a) => s + a.amount, 0);
  const unallocated = record ? Math.max(0, Number(record.amount ?? 0) - allocatedTotal) : 0;

  return (
    <DocumentPeekShell
      open={!!paymentId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load payment"
      title={loading ? "Loading payment…" : record ? `Payment ${(record as any).receipt_number ?? record.id.slice(0, 8)}` : "Payment"}
      description={record ? (
        <span className="flex flex-wrap items-center gap-2">
          {status && <StatusBadge tone={status === "voided" ? "danger" : status === "unreconciled" ? "warning" : "success"}>{methodLabel(status)}</StatusBadge>}
          <span className="text-muted-foreground">{(record as any).contact?.name ?? "Customer"}</span>
        </span>
      ) : undefined}
      fullPageHref={record ? `/sales/payments/${record.id}` : undefined}
    >
      {record && (
        <div className="space-y-5">
          <Section title="Details">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs font-medium text-muted-foreground">Customer</dt><dd className="mt-0.5">{(record as any).contact?.name ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Amount</dt><dd className="mt-0.5 tabular-nums">{formatCurrency(Number(record.amount ?? 0))}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Method</dt><dd className="mt-0.5">{methodLabel(record.payment_method)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Payment date</dt><dd className="mt-0.5">{fmt(record.payment_date)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Reference</dt><dd className="mt-0.5">{record.reference ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Receipt #</dt><dd className="mt-0.5">{record.receipt_number ?? "—"}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs font-medium text-muted-foreground">Notes</dt><dd className="mt-0.5 whitespace-pre-line">{record.notes ?? "—"}</dd></div>
            </dl>
          </Section>

          <Section title="Allocations">
            {allocations.length === 0 ? (
              <p className="text-sm text-muted-foreground">Unallocated — this payment is held as a customer credit.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border">
                {allocations.map((a, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate">{a.invoice?.invoice_number ?? "Invoice"}</span>
                    <span className="tabular-nums">{formatCurrency(a.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-baseline justify-between rounded-md bg-muted/40 px-3 py-2">
                <span className="text-muted-foreground">Allocated</span>
                <span className="tabular-nums font-medium">{formatCurrency(allocatedTotal)}</span>
              </div>
              <div className="flex items-baseline justify-between rounded-md bg-muted/40 px-3 py-2">
                <span className="text-muted-foreground">Unallocated</span>
                <span className="tabular-nums font-medium">{formatCurrency(unallocated)}</span>
              </div>
            </div>
          </Section>

          <Section title="Activity">
            <DocumentActivityPanel entries={[
              { id: "created", at: fmt(record.created_at), actor: "System", title: `Payment received` },
            ]} />
          </Section>
        </div>
      )}
    </DocumentPeekShell>
  );
}
