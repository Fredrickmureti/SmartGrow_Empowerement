/**
 * purchaseOrderView — the one description of a Purchase Order.
 *
 * The record page and the list peek previously each declared their own
 * status map, detail fields, line columns and totals ladder. They now both
 * consume this builder, so there is a single place where "what a purchase
 * order looks like" is decided.
 */
import { useMemo } from "react";
import { format } from "date-fns";

import type {
  DocumentRecordView,
  LineItemColumn,
  LineItemRow,
} from "@/design-system/records";
import { Section } from "@/design-system";
import { AddressBlock } from "@/components/addresses/AddressBlock";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";
import type { PurchaseOrder } from "@/hooks/usePurchaseOrders";
import { PurchaseOrderReceiptsSection } from "@/features/purchases/goods-receipt/PurchaseOrderReceiptsSection";
import { usePurchaseOrderRecord } from "./usePurchaseOrderRecord";

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

function formatStatus(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const COLUMNS: LineItemColumn[] = [
  { id: "description", header: "Description", priority: 1, minWidth: 200 },
  { id: "qty", header: "Qty", numeric: true, priority: 1, minWidth: 70, compactLabel: "Qty" },
  { id: "received", header: "Received", numeric: true, priority: 3, minWidth: 90, compactLabel: "Recv" },
  { id: "unit", header: "Unit price", numeric: true, priority: 2, minWidth: 110, compactLabel: "@" },
  { id: "tax", header: "Tax %", numeric: true, priority: 3, minWidth: 80, compactLabel: "Tax" },
  { id: "total", header: "Subtotal", numeric: true, priority: 1, minWidth: 110 },
];

interface Result {
  po: PurchaseOrder | null;
  loading: boolean;
  error: string | null;
  view: DocumentRecordView;
  refresh: () => void;
}

export function usePurchaseOrderView(
  id: string | null | undefined,
  formatCurrency: (v: number) => string,
): Result {
  const { record, loading, error, refetch } = usePurchaseOrderRecord(id);
  const po = record ?? null;

  const view = useMemo<DocumentRecordView>(() => {
    const rows: LineItemRow[] = (po?.items ?? [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "received", content: line.quantity_received ?? 0 },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "tax", content: line.tax_rate ?? 0 },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));

    return {
      kind: "purchase_order",
      documentId: po?.id,
      eyebrow: "Purchase Order",
      listPath: "/purchases/orders",
      title: po?.vendor?.name ?? "Vendor",
      docNumber: po?.po_number,
      status: po?.status,
      loading,
      error,
      notFound: !loading && !error && !po,
      meta: po ? (
        <>
          <span>Ordered {fmtDate(po.order_date)}</span>
          <span>Expected {fmtDate(po.expected_date)}</span>
          <span className="tabular-nums">
            {formatCurrency(po.total ?? 0)} {po.currency}
          </span>
        </>
      ) : undefined,
      money: po
        ? {
            subtotal: po.subtotal ?? 0,
            discount: po.discount_amount ?? 0,
            tax: po.tax_amount ?? 0,
            total: po.total ?? 0,
          }
        : undefined,
      totalsFooter: po ? `Currency ${po.currency}` : undefined,
      detailFields: po
        ? [
            { label: "Vendor", value: po.vendor?.name ?? "—" },
            { label: "Order date", value: fmtDate(po.order_date) },
            { label: "Expected date", value: fmtDate(po.expected_date) },
            { label: "Currency", value: po.currency },
            {
              label: "Contract",
              value:
                (po as any).contract?.contract_number
                  ? `${(po as any).contract.contract_number} — ${(po as any).contract.title}`
                  : "Spot buy (no contract)",
            },
            { label: "Billing status", value: formatStatus(po.billing_status ?? "no") },
            {
              // A PO destination is OUR location, never the supplier's
              // address — the label has to say so.
              label: "Deliver to (our location)",
              value: (
                <AddressBlock
                  name={
                    po.deliver_to_warehouse?.name ??
                    po.deliver_to_branch?.name ??
                    null
                  }
                  address={po.shipping_address}
                  provenance={
                    po.deliver_to_warehouse_id || po.deliver_to_branch_id
                      ? "internal"
                      : po.shipping_address
                        ? "custom"
                        : "none"
                  }
                />
              ),
            },
          ]
        : undefined,
      lineColumns: COLUMNS,
      lineRows: rows,
      lineEmpty: "No line items on this purchase order.",
      extraSections: po ? (
        <>
          {po.notes && (
            <Section title="Notes">
              <p className="whitespace-pre-wrap text-sm">{po.notes}</p>
            </Section>
          )}
          {/*
            ADR 0128 — the receipts this order produced, and the only operator
            entry point to reverse one. Reversal itself is server-side
            (`void_goods_receipt_atomic`); this only surfaces it.
          */}
          <PurchaseOrderReceiptsSection purchaseOrderId={po.id} currency={po.currency} />
          <DocumentVersionsSection documentType="purchase_order" documentId={po.id} />
        </>
      ) : undefined,

      activityExtra:
        po && po.converted_at
          ? [
              {
                id: "converted",
                at: fmtDate(po.converted_at),
                title: "Converted to bill",
                tone: "success" as const,
              },
            ]
          : undefined,
    };
  }, [po, loading, error, formatCurrency]);

  return { po, loading, error, view, refresh: refetch };
}
