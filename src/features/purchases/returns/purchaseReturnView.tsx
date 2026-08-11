/**
 * purchaseReturnView — the one description of a Purchase Return.
 *
 * Mirrors invoiceView: the record page and the list peek both consume this
 * builder so "what a purchase return looks like" is decided in one place.
 *
 * It deliberately surfaces the three things a return is accountable for:
 *   - provenance (goods receipt / PO / warehouse the stock came from),
 *   - physical discharge (dispatch, supplier acknowledgement, WMS order),
 *   - financial settlement (the vendor debit note and its journal).
 * All of them are server-owned columns, so this projection can be trusted.
 */
import { useMemo } from "react";
import { format } from "date-fns";
import { Link } from "react-router-dom";

import type {
  DocumentRecordView,
  LineItemColumn,
  LineItemRow,
} from "@/design-system/records";
import { Section } from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";
import type { PurchaseReturn } from "@/hooks/usePurchaseReturns";
import { reasonCodeLabel } from "@/lib/purchases/purchaseReturnRpcs";
import { usePurchaseReturnRecord } from "./usePurchaseReturnRecord";
import { usePurchaseReturnEvents } from "./usePurchaseReturnEvents";

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

function fmtStamp(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PPp");
  } catch {
    return v;
  }
}

const COLUMNS: LineItemColumn[] = [
  { id: "description", header: "Description", priority: 1, minWidth: 200 },
  { id: "trace", header: "Traceability", priority: 3, minWidth: 150 },
  { id: "qty", header: "Qty", numeric: true, priority: 2, minWidth: 70, compactLabel: "Qty" },
  { id: "unit", header: "Unit cost", numeric: true, priority: 2, minWidth: 110, compactLabel: "@" },
  { id: "total", header: "Subtotal", numeric: true, priority: 1, minWidth: 110 },
];

interface Result {
  purchaseReturn: PurchaseReturn | null;
  loading: boolean;
  error: string | null;
  view: DocumentRecordView;
  refresh: () => void;
}

export function usePurchaseReturnView(
  id: string | null | undefined,
  formatCurrency: (v: number) => string,
): Result {
  const { record: purchaseReturn, loading, error, refetch } = usePurchaseReturnRecord(id);
  const { events } = usePurchaseReturnEvents(purchaseReturn?.id ?? null);

  const view = useMemo<DocumentRecordView>(() => {
    const items = (purchaseReturn?.items ?? []) as NonNullable<PurchaseReturn["items"]>;
    const rows: LineItemRow[] = items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          {
            columnId: "trace",
            content: (
              <span className="flex flex-wrap gap-1">
                {line.goods_receipt_item_id ? (
                  <Badge variant="outline" className="text-[10px]">
                    From receipt
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    No receipt basis
                  </Badge>
                )}
                {line.lot_number && (
                  <Badge variant="outline" className="text-[10px]">
                    Lot {line.lot_number}
                  </Badge>
                )}
                {line.serial_number && (
                  <Badge variant="outline" className="text-[10px]">
                    S/N {line.serial_number}
                  </Badge>
                )}
                {line.condition && (
                  <span className="text-[10px] text-muted-foreground">{line.condition}</span>
                )}
              </span>
            ),
          },
          { columnId: "qty", content: line.quantity },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));

    const kindLabel =
      purchaseReturn?.return_kind === "financial"
        ? "Financial adjustment — no goods movement"
        : "Goods return";

    return {
      kind: "purchase_return",
      documentId: purchaseReturn?.id,
      eyebrow: "Purchase Return",
      listPath: "/purchases/returns",
      title: purchaseReturn?.vendor?.name ?? "Supplier",
      docNumber: purchaseReturn?.return_number,
      status: purchaseReturn?.status,
      loading,
      error,
      notFound: !loading && !error && !purchaseReturn,
      meta: purchaseReturn ? (
        <>
          <span>Returned {fmtDate(purchaseReturn.return_date)}</span>
          <span className="tabular-nums">
            {formatCurrency(purchaseReturn.total ?? 0)} {purchaseReturn.currency ?? ""}
          </span>
          <span>{kindLabel}</span>
          {purchaseReturn.reason_code && (
            <span>Reason: {reasonCodeLabel(purchaseReturn.reason_code)}</span>
          )}
        </>
      ) : undefined,
      totalsRows: purchaseReturn
        ? [
            { label: "Subtotal", value: formatCurrency(purchaseReturn.subtotal ?? 0) },
            { label: "Tax", value: formatCurrency(purchaseReturn.tax_amount ?? 0) },
            {
              label: "Total",
              value: formatCurrency(purchaseReturn.total ?? 0),
              emphasized: true,
            },
          ]
        : undefined,
      totalsFooter: purchaseReturn?.currency
        ? `Currency ${purchaseReturn.currency}`
        : undefined,
      detailFields: purchaseReturn
        ? [
            { label: "Supplier", value: purchaseReturn.vendor?.name ?? "—" },
            { label: "Return date", value: fmtDate(purchaseReturn.return_date) },
            { label: "Return type", value: kindLabel },
            {
              label: "Reason",
              value: purchaseReturn.reason_code
                ? reasonCodeLabel(purchaseReturn.reason_code)
                : purchaseReturn.reason || "—",
            },
            { label: "Reason detail", value: purchaseReturn.reason || "—" },
            { label: "Currency", value: purchaseReturn.currency ?? "—" },
            { label: "RMA reference", value: purchaseReturn.rma_reference || "—" },
            {
              label: "Stock released",
              value: purchaseReturn.dispatched_at
                ? `Dispatched ${fmtStamp(purchaseReturn.dispatched_at)}`
                : "Not yet — stock is still on hand",
            },
            {
              label: "Debit note",
              value: purchaseReturn.vendor_credit_note_id ? "Raised" : "Not raised",
            },
          ]
        : undefined,
      lineColumns: COLUMNS,
      lineRows: rows,
      lineEmpty: "No line items on this return.",
      extraSections: purchaseReturn ? (
        <>
          <Section title="Source documents">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Goods receipt</dt>
                <dd>
                  {purchaseReturn.goods_receipt_id ? (
                    <Link
                      className="text-primary underline-offset-2 hover:underline"
                      to={`/purchases/goods-receipts/${purchaseReturn.goods_receipt_id}`}
                    >
                      View receipt
                    </Link>
                  ) : (
                    "— (no receipt provenance)"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Purchase order</dt>
                <dd>
                  {purchaseReturn.purchase_order_id ? (
                    <Link
                      className="text-primary underline-offset-2 hover:underline"
                      to={`/purchases/orders/${purchaseReturn.purchase_order_id}`}
                    >
                      View order
                    </Link>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Vendor debit note</dt>
                <dd>
                  {purchaseReturn.vendor_credit_note_id ? (
                    <Link
                      className="text-primary underline-offset-2 hover:underline"
                      to={`/purchases/vendor-credit-notes/${purchaseReturn.vendor_credit_note_id}`}
                    >
                      View debit note
                    </Link>
                  ) : (
                    "— not yet raised"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Warehouse return order</dt>
                <dd>{purchaseReturn.wms_return_order_id ? "Created in WMS" : "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Approval request</dt>
                <dd>{purchaseReturn.approval_request_id ? "Governed by approval" : "Direct authority"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Journal entry</dt>
                <dd>{purchaseReturn.journal_entry_id ? "Posted" : "—"}</dd>
              </div>
            </dl>
          </Section>

          <Section title="Lifecycle">
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No lifecycle events recorded yet.
              </p>
            ) : (
              <ol className="space-y-2 text-sm">
                {events.map((ev) => (
                  <li key={ev.id} className="flex flex-wrap items-baseline gap-2">
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {ev.event_type}
                    </Badge>
                    <span>
                      {ev.from_status ? `${ev.from_status} → ` : ""}
                      {ev.to_status ?? "—"}
                    </span>
                    {ev.governance_mode && (
                      <span className="text-xs text-muted-foreground">
                        via {ev.governance_mode}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {fmtStamp(ev.created_at)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          {purchaseReturn.notes && (
            <Section title="Notes">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {purchaseReturn.notes}
              </p>
            </Section>
          )}
          <DocumentVersionsSection
            documentType="purchase_return"
            documentId={purchaseReturn.id}
          />
        </>
      ) : undefined,
    };
  }, [purchaseReturn, loading, error, formatCurrency, events]);

  return { purchaseReturn, loading, error, view, refresh: refetch };
}
