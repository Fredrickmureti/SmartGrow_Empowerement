/**
 * SalesOrderPeekSheet — standard peek for one sales order. Read-oriented;
 * fulfillment and conversion actions stay in the parent list row menu.
 */
import { useMemo } from "react";
import { format } from "date-fns";
import { Section, StatusBadge } from "@/design-system";
import {
  DocumentActivityPanel,
  DocumentPeekShell,
  DocumentTotalsPanel,
  LineItemsGrid,
  type LineItemColumn,
  type LineItemRow,
} from "@/features/sales/record";
import { useCurrency } from "@/hooks/useCurrency";
import type { SalesOrder } from "@/hooks/useSalesOrders";
import { useSalesOrderRecord } from "./useSalesOrderRecord";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger" | "accent"> = {
  draft: "neutral", pending_approval: "warning", confirmed: "info",
  partially_fulfilled: "warning", fulfilled: "success", cancelled: "danger",
  converted: "success",
};
const label = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const fmt = (v?: string | null) => { if (!v) return "—"; try { return format(new Date(v), "PP"); } catch { return v; } };

interface Props { salesOrderId: string | null; onOpenChange: (o: boolean) => void; }

export function SalesOrderPeekSheet({ salesOrderId, onOpenChange }: Props) {
  const { record, loading, error } = useSalesOrderRecord(salesOrderId);
  const { formatCurrency } = useCurrency();

  const columns = useMemo<LineItemColumn[]>(() => [
    { id: "description", header: "Description", width: "minmax(0,1fr)" },
    { id: "qty", header: "Qty", width: "64px", numeric: true },
    { id: "unit", header: "Unit", width: "110px", numeric: true },
    { id: "total", header: "Subtotal", width: "120px", numeric: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const items = (record?.items ?? []) as any[];
    return items.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));
  }, [record, formatCurrency]);

  return (
    <DocumentPeekShell
      open={!!salesOrderId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load sales order"
      title={loading ? "Loading sales order…" : record ? `Sales Order ${record.so_number}` : "Sales Order"}
      description={record ? (
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={TONE[record.status] ?? "neutral"}>{label(record.status)}</StatusBadge>
          <span className="text-muted-foreground">{record.contact?.name ?? "Customer"}</span>
        </span>
      ) : undefined}
      fullPageHref={record ? `/sales/orders/${record.id}` : undefined}
    >
      {record && (
        <div className="space-y-5">
          <Section title="Details">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs font-medium text-muted-foreground">Customer</dt><dd className="mt-0.5">{record.contact?.name ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Email</dt><dd className="mt-0.5">{record.contact?.email ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Order date</dt><dd className="mt-0.5">{fmt(record.order_date)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Expected</dt><dd className="mt-0.5">{fmt(record.expected_date)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Currency</dt><dd className="mt-0.5">{record.currency}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Total</dt><dd className="mt-0.5 tabular-nums">{formatCurrency(record.total ?? 0)}</dd></div>
            </dl>
          </Section>
          <Section title="Totals">
            <DocumentTotalsPanel rows={[
              { label: "Subtotal", value: formatCurrency(record.subtotal ?? 0) },
              { label: "Discount", value: `- ${formatCurrency(record.discount_amount ?? 0)}`, muted: true },
              { label: "Tax", value: formatCurrency(record.tax_amount ?? 0) },
              { label: "Shipping", value: formatCurrency(record.shipping_amount ?? 0), muted: true },
              { label: "Total", value: formatCurrency(record.total ?? 0), emphasized: true },
            ]} footer={`Currency ${record.currency}`} />
          </Section>
          <Section title="Line items"><LineItemsGrid columns={columns} rows={rows} readOnly /></Section>
          <Section title="Activity">
            <DocumentActivityPanel entries={[
              { id: "created", at: fmt(record.created_at), actor: "System", title: `Sales order ${record.so_number} created` },
              ...(record.converted_at ? [{ id: "converted", at: fmt(record.converted_at), title: "Converted to invoice", tone: "success" as const }] : []),
            ]} />
          </Section>
          <DocumentVersionsSection documentType="sales_order" documentId={salesOrderId} />
        </div>
      )}
    </DocumentPeekShell>
  );
}
