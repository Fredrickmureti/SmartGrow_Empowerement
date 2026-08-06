/**
 * RecurringInvoicePeekSheet — standard peek for one recurring template.
 * Run-now / pause / edit actions stay in the parent list row menu.
 */
import { useMemo } from "react";
import { format } from "date-fns";
import { Section, StatusBadge } from "@/design-system";
import {
  DocumentActivityPanel,
  DocumentPeekShell,
  LineItemsGrid,
  type LineItemColumn,
  type LineItemRow,
} from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import type { RecurringInvoice } from "@/hooks/useRecurringInvoices";
import { useRecurringInvoiceRecord } from "./useRecurringInvoiceRecord";

const fmt = (v?: string | null) => { if (!v) return "—"; try { return format(new Date(v), "PP"); } catch { return v; } };

interface Props { recurringId: string | null; onOpenChange: (o: boolean) => void; }

export function RecurringInvoicePeekSheet({ recurringId, onOpenChange }: Props) {
  const { record, loading, error } = useRecurringInvoiceRecord(recurringId);
  const { formatCurrency } = useCurrency();

  const columns = useMemo<LineItemColumn[]>(() => [
    { id: "description", header: "Description", width: "minmax(0,1fr)" },
    { id: "qty", header: "Qty", width: "64px", numeric: true },
    { id: "unit", header: "Unit", width: "110px", numeric: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const items = ((record as any)?.items ?? []) as any[];
    return items.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
        ],
      }));
  }, [record, formatCurrency]);

  return (
    <DocumentPeekShell
      open={!!recurringId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load recurring template"
      title={loading ? "Loading template…" : record ? record.template_name : "Recurring template"}
      description={record ? (
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={record.is_active ? "success" : "neutral"}>
            {record.is_active ? "Active" : "Paused"}
          </StatusBadge>
          <span className="text-muted-foreground">{record.contact?.name ?? "Customer"}</span>
        </span>
      ) : undefined}
      fullPageHref={record ? `/sales/recurring/${record.id}` : undefined}
    >
      {record && (
        <div className="space-y-5">
          <Section title="Schedule">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs font-medium text-muted-foreground">Customer</dt><dd className="mt-0.5">{record.contact?.name ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Frequency</dt><dd className="mt-0.5 capitalize">{record.frequency}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Start</dt><dd className="mt-0.5">{fmt(record.start_date)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">End</dt><dd className="mt-0.5">{fmt(record.end_date)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Next run</dt><dd className="mt-0.5">{fmt(record.next_run_date)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Last run</dt><dd className="mt-0.5">{fmt(record.last_run_date)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Auto-send</dt><dd className="mt-0.5">{record.auto_send ? "Yes" : "No"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Generated</dt><dd className="mt-0.5">{record.invoices_generated}</dd></div>
            </dl>
          </Section>
          <Section title="Line items"><LineItemsGrid columns={columns} rows={rows} readOnly /></Section>
          <Section title="Activity">
            <DocumentActivityPanel entries={[
              { id: "created", at: fmt(record.created_at), actor: "System", title: `Template ${record.template_name} created` },
              ...(record.last_run_date ? [{ id: "last-run", at: fmt(record.last_run_date), title: "Ran generation", tone: "info" as const }] : []),
            ]} />
          </Section>
        </div>
      )}
    </DocumentPeekShell>
  );
}
