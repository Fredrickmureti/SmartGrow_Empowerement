/**
 * salesOrderView — the one description of a Sales Order, shared by the
 * object page and the list peek.
 */
import { useMemo } from "react";
import { format } from "date-fns";

import type {
  DocumentRecordView,
  LineItemColumn,
  LineItemRow,
} from "@/design-system/records";
import { Section } from "@/design-system";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";
import type { SalesOrder } from "@/hooks/useSalesOrders";
import { useSalesOrderRecord } from "./useSalesOrderRecord";

const fmt = (v?: string | null) => {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
};

const COLUMNS: LineItemColumn[] = [
  { id: "description", header: "Description", priority: 1, minWidth: 200 },
  { id: "qty", header: "Qty", numeric: true, priority: 2, minWidth: 70, compactLabel: "Qty" },
  { id: "fulfilled", header: "Fulfilled", numeric: true, priority: 3, minWidth: 90, compactLabel: "Fulfilled" },
  { id: "unit", header: "Unit price", numeric: true, priority: 2, minWidth: 110, compactLabel: "@" },
  { id: "disc", header: "Disc %", numeric: true, priority: 3, minWidth: 80, compactLabel: "Disc" },
  { id: "tax", header: "Tax %", numeric: true, priority: 3, minWidth: 80, compactLabel: "Tax" },
  { id: "total", header: "Subtotal", numeric: true, priority: 1, minWidth: 110 },
];

interface Result {
  order: SalesOrder | null;
  loading: boolean;
  error: string | null;
  view: DocumentRecordView;
}

export function useSalesOrderView(
  id: string | null | undefined,
  formatCurrency: (v: number) => string,
): Result {
  const { record, loading, error } = useSalesOrderRecord(id);
  const order = record ?? null;

  const view = useMemo<DocumentRecordView>(() => {
    const rows: LineItemRow[] = ((order?.items ?? []) as SalesOrder["items"])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "fulfilled", content: line.quantity_fulfilled ?? 0 },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "disc", content: line.discount_percent ?? 0 },
          { columnId: "tax", content: line.tax_rate ?? 0 },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));

    return {
      kind: "sales_order",
      eyebrow: "Sales Order",
      listPath: "/sales/orders",
      title: order?.contact?.name ?? "Customer",
      docNumber: order?.so_number,
      status: order?.status,
      loading,
      error,
      notFound: !loading && !error && !order,
      meta: order ? (
        <>
          <span>Ordered {fmt(order.order_date)}</span>
          <span>Expected {fmt(order.expected_date)}</span>
          <span className="tabular-nums">
            {formatCurrency(order.total ?? 0)} {order.currency}
          </span>
        </>
      ) : undefined,
      lifecycle: order ? { docType: "sales_order", docId: order.id } : undefined,
      money: order
        ? {
            subtotal: order.subtotal ?? 0,
            discount: order.discount_amount ?? 0,
            tax: order.tax_amount ?? 0,
            shipping: order.shipping_amount ?? 0,
            total: order.total ?? 0,
          }
        : undefined,
      totalsFooter: order ? `Currency ${order.currency}` : undefined,
      detailFields: order
        ? [
            { label: "Customer", value: order.contact?.name ?? "—" },
            { label: "Email", value: order.contact?.email ?? "—" },
            { label: "Order date", value: fmt(order.order_date) },
            { label: "Expected date", value: fmt(order.expected_date) },
            { label: "Currency", value: order.currency },
            {
              label: "Shipping address",
              value: (
                <span className="whitespace-pre-wrap">
                  {order.shipping_address ?? "—"}
                </span>
              ),
            },
          ]
        : undefined,
      lineColumns: COLUMNS,
      lineRows: rows,
      lineEmpty: "No line items on this order.",
      extraSections: order ? (
        <>
          {order.notes && (
            <Section title="Notes">
              <p className="whitespace-pre-wrap text-sm">{order.notes}</p>
            </Section>
          )}
          <DocumentVersionsSection documentType="sales_order" documentId={order.id} />
        </>
      ) : undefined,
      activityExtra:
        order && order.converted_at
          ? [
              {
                id: "converted",
                at: fmt(order.converted_at),
                title: "Converted to invoice",
                tone: "success" as const,
              },
            ]
          : undefined,
    };
  }, [order, loading, error, formatCurrency]);

  return { order, loading, error, view };
}
