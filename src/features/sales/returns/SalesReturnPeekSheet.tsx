/**
 * SalesReturnPeekSheet — standard peek for one sales return. Approval /
 * refund actions stay in the parent list row menu.
 */
import { useMemo } from "react";
import { format } from "date-fns";
import { Section } from "@/design-system";
import {
  DocumentActivityPanel,
  DocumentPeekShell,
  DocumentStatusBadge,
  DocumentTotalsPanel,
  LineItemsGrid,
  type LineItemColumn,
  type LineItemRow,
} from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import type { SalesReturn } from "@/hooks/useSalesReturns";
import { useSalesReturnRecord } from "./useSalesReturnRecord";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

const fmt = (v?: string | null) => { if (!v) return "—"; try { return format(new Date(v), "PP"); } catch { return v; } };

interface Props { salesReturnId: string | null; onOpenChange: (o: boolean) => void; }

export function SalesReturnPeekSheet({ salesReturnId, onOpenChange }: Props) {
  const { record, loading, error } = useSalesReturnRecord(salesReturnId);
  const { formatCurrency } = useCurrency();

  const columns = useMemo<LineItemColumn[]>(() => [
    { id: "description", header: "Description", width: "minmax(0,1fr)" },
    { id: "qty", header: "Qty", width: "64px", numeric: true },
    { id: "unit", header: "Unit", width: "110px", numeric: true },
    { id: "total", header: "Subtotal", width: "120px", numeric: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const items = ((record as any)?.items ?? []) as any[];
    return items.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity ?? line.quantity_returned ?? "—" },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));
  }, [record, formatCurrency]);

  return (
    <DocumentPeekShell
      open={!!salesReturnId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load sales return"
      title={loading ? "Loading sales return…" : record ? `Return ${record.return_number}` : "Sales Return"}
      description={record ? (
        <span className="flex flex-wrap items-center gap-2">
          <DocumentStatusBadge kind="sales_return" status={record.status} />
          <span className="text-muted-foreground">{(record as any).contact?.name ?? "Customer"}</span>
        </span>
      ) : undefined}
      fullPageHref={record ? `/sales/returns/${record.id}` : undefined}
    >
      {record && (
        <div className="space-y-5">
          <Section title="Details">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs font-medium text-muted-foreground">Customer</dt><dd className="mt-0.5">{(record as any).contact?.name ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Original invoice</dt><dd className="mt-0.5">{(record as any).invoice?.invoice_number ?? "—"}</dd></div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Origin</dt>
                <dd className="mt-0.5">
                  {(record as any).wms_return_order
                    ? `Warehouse RMA ${(record as any).wms_return_order.code ?? ""}`.trim()
                    : "Direct (sales-raised)"}
                </dd>
              </div>
              <div><dt className="text-xs font-medium text-muted-foreground">Return date</dt><dd className="mt-0.5">{fmt(record.return_date)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Refund method</dt><dd className="mt-0.5">{record.refund_method ?? "—"}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs font-medium text-muted-foreground">Reason</dt><dd className="mt-0.5 whitespace-pre-line">{record.reason ?? "—"}</dd></div>
            </dl>
          </Section>
          <Section title="Totals">
            <DocumentTotalsPanel rows={[
              { label: "Subtotal", value: formatCurrency(record.subtotal ?? 0) },
              { label: "Tax", value: formatCurrency(record.tax_amount ?? 0) },
              { label: "Total refund", value: formatCurrency(record.total ?? 0), emphasized: true },
            ]} footer={`Currency ${record.currency}`} />
          </Section>
          <Section title="Line items"><LineItemsGrid columns={columns} rows={rows} readOnly /></Section>
          <Section title="Activity">
            <DocumentActivityPanel entries={[
              { id: "created", at: fmt(record.created_at), actor: "System", title: `Return ${record.return_number} created` },
              ...((record as any).wms_return_order
                ? [{
                    id: "wms-origin",
                    at: fmt(record.created_at),
                    title: "Stock movements owned by the warehouse RMA",
                    tone: "info" as const,
                  }]
                : []),
            ]} />
          </Section>
          <DocumentVersionsSection documentType="sales_return" documentId={salesReturnId} />
        </div>
      )}
    </DocumentPeekShell>
  );
}
