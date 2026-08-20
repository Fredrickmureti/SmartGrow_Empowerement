/**
 * SourceDocumentPeekSheet — the drawer projection of a generic "source
 * document" reference (PO, invoice, bill, sales order, delivery note, GRN,
 * POS transaction, stock adjustment, stock transfer).
 *
 * The peek is not a label: an operator arriving here from a lot genealogy
 * row must be able to answer *what this document is, what moved on it, and
 * where it sits in its lifecycle* without leaving the drawer. So each
 * reference type declares:
 *
 *   - a header projection  (counterparty, dates, approval, logistics)
 *   - a line projection    (what was delivered / adjusted / transferred)
 *   - a money projection   (when the document carries value)
 *
 * All of it is expressed as one `DocumentRecordView` and rendered by
 * `PeekScaffold`, so the drawer cannot drift from the full record page.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";

import { PeekScaffold } from "@/design-system/records";
import type { DocumentRecordView } from "@/design-system/records";
import type {
  LineItemColumn,
  LineItemRow,
  LineItemRowCell,
} from "@/design-system/records/LineItemsGrid";
import type { DetailField } from "@/design-system/records/RecordBody";
import type { DocumentKind } from "@/design-system/records/documentStatus";
import type { LifecycleDocType } from "@/design-system/records/DocumentLifecycleStrip";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";

interface SourceDocumentPeekSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  referenceType: string | null;
  referenceId: string | null;
}

/** How a document's lines are read and shaped. */
type LineShape = "priced" | "shipment" | "adjustment" | "transfer";

interface DocConfig {
  table: string;
  select: string;
  titleField: string;
  dateField: string;
  statusField?: string;
  totalField?: string;
  contactField?: string;
  route: string;
  /** Full record page for this document, when one exists. */
  recordPath?: (id: string) => string;
  kind: DocumentKind;
  /** Order-to-cash strip anchor, when the document participates in it. */
  lifecycle?: LifecycleDocType;
  lines?: {
    table: string;
    fk: string;
    select: string;
    orderBy?: string;
    shape: LineShape;
  };
}

const PRODUCT_JOIN = "products(name, sku)";

const DOC_CONFIG: Record<string, DocConfig> = {
  purchase_order: {
    table: "purchase_orders",
    select: "*, contacts(company_name, name)",
    titleField: "order_number",
    dateField: "order_date",
    statusField: "status",
    totalField: "total",
    contactField: "contacts",
    route: "/purchases",
    recordPath: (id) => `/purchases/orders/${id}`,
    kind: "purchase_order",
    lines: {
      table: "purchase_order_items",
      fk: "purchase_order_id",
      select: `id, description, quantity, quantity_received, unit_price, line_total, uom_snapshot, ${PRODUCT_JOIN}`,
      orderBy: "sort_order",
      shape: "priced",
    },
  },
  invoice: {
    table: "invoices",
    select: "*, contacts(company_name, name)",
    titleField: "invoice_number",
    dateField: "invoice_date",
    statusField: "status",
    totalField: "total",
    contactField: "contacts",
    route: "/invoices",
    recordPath: (id) => `/sales/invoices/${id}`,
    kind: "invoice",
    lifecycle: "invoice",
    lines: {
      table: "invoice_items",
      fk: "invoice_id",
      select: `id, description, quantity, unit_price, line_total, lot_number, uom_snapshot, ${PRODUCT_JOIN}`,
      orderBy: "sort_order",
      shape: "priced",
    },
  },
  bill: {
    table: "bills",
    select: "*, vendor:contacts!bills_vendor_id_fkey(company_name, name)",
    titleField: "bill_number",
    dateField: "bill_date",
    statusField: "status",
    totalField: "total",
    contactField: "vendor",
    route: "/bills",
    recordPath: (id) => `/purchases/bills/${id}`,
    kind: "bill",
    lines: {
      table: "bill_items",
      fk: "bill_id",
      select: `id, description, quantity, unit_price, line_total, uom_snapshot, ${PRODUCT_JOIN}`,
      orderBy: "sort_order",
      shape: "priced",
    },
  },
  sales_order: {
    table: "sales_orders",
    select: "*, customer:contacts!sales_orders_contact_id_fkey(company_name, name)",
    titleField: "order_number",
    dateField: "order_date",
    statusField: "status",
    totalField: "total",
    contactField: "customer",
    route: "/sales",
    recordPath: (id) => `/sales/orders/${id}`,
    kind: "sales_order",
    lifecycle: "sales_order",
    lines: {
      table: "sales_order_items",
      fk: "sales_order_id",
      select: `id, description, quantity, quantity_fulfilled, unit_price, line_total, uom_snapshot, ${PRODUCT_JOIN}`,
      orderBy: "sort_order",
      shape: "priced",
    },
  },
  delivery_note: {
    table: "delivery_notes",
    select:
      "*, customer:contacts!delivery_notes_contact_id_fkey(company_name, name), ship_to:contacts!delivery_notes_ship_to_contact_id_fkey(company_name, name), sales_orders(order_number), source_invoice:invoices!delivery_notes_source_invoice_id_fkey(invoice_number, status), spawned_invoice:invoices!delivery_notes_spawned_invoice_id_fkey(invoice_number, status), warehouses(name)",
    titleField: "delivery_number",
    dateField: "delivery_date",
    statusField: "status",
    contactField: "customer",
    route: "/delivery-notes",
    recordPath: (id) => `/sales/delivery-notes/${id}`,
    kind: "delivery_note",
    lifecycle: "delivery_note",
    lines: {
      table: "delivery_note_items",
      fk: "delivery_note_id",
      select: `id, description, product_name_snapshot, product_sku_snapshot, quantity_ordered, quantity_delivered, lot_number, serial_number, uom_snapshot, ${PRODUCT_JOIN}`,
      orderBy: "sort_order",
      shape: "shipment",
    },
  },
  credit_note: {
    table: "credit_notes",
    select: "*, contacts(company_name, name)",
    titleField: "credit_note_number",
    dateField: "issue_date",
    statusField: "status",
    totalField: "total",
    contactField: "contacts",
    route: "/sales/credit-notes",
    recordPath: (id) => `/sales/credit-notes/${id}`,
    kind: "credit_note",
    lines: {
      table: "credit_note_items",
      fk: "credit_note_id",
      select: `id, description, quantity, unit_price, line_total, lot_number, uom_snapshot, ${PRODUCT_JOIN}`,
      orderBy: "sort_order",
      shape: "priced",
    },
  },
  sales_return: {
    table: "sales_returns",
    select: "*, contacts(company_name, name)",
    titleField: "return_number",
    dateField: "return_date",
    statusField: "status",
    totalField: "total",
    contactField: "contacts",
    route: "/sales/returns",
    recordPath: (id) => `/sales/returns/${id}`,
    kind: "sales_return",
    lines: {
      table: "sales_return_items",
      fk: "sales_return_id",
      select: `id, description, quantity, unit_price, line_total, lot_number, condition, return_reason, uom_snapshot, ${PRODUCT_JOIN}`,
      orderBy: "sort_order",
      shape: "priced",
    },
  },
  goods_receipt: {
    table: "goods_receipts",
    select: "*, purchase_orders(order_number), warehouses(name)",
    titleField: "receipt_number",
    dateField: "receipt_date",
    statusField: "status",
    route: "/warehouse-app/receiving",
    kind: "generic",
    lines: {
      table: "goods_receipt_items",
      fk: "goods_receipt_id",
      select: `id, description, quantity_ordered, quantity_received, unit_cost_basis, lot_number, serial_number, uom_snapshot, ${PRODUCT_JOIN}`,
      orderBy: "sort_order",
      shape: "shipment",
    },
  },
  pos_transaction: {
    table: "pos_transactions",
    select: "*",
    titleField: "transaction_number",
    dateField: "created_at",
    statusField: "status",
    totalField: "total",
    route: "/pos",
    kind: "generic",
    lines: {
      table: "pos_transaction_items",
      fk: "transaction_id",
      select: `id, description, quantity, unit_price, line_total, lot_number, uom_snapshot, ${PRODUCT_JOIN}`,
      orderBy: "sort_order",
      shape: "priced",
    },
  },
  stock_adjustment: {
    table: "stock_adjustments",
    select: "*, warehouses(name)",
    titleField: "adjustment_number",
    dateField: "adjustment_date",
    statusField: "status",
    route: "/inventory-app/stock",
    kind: "stock_adjustment",
    lines: {
      table: "stock_adjustment_items",
      fk: "adjustment_id",
      select: `id, quantity_before, quantity_adjustment, quantity_after, unit_cost, lot_number, notes, uom_snapshot, ${PRODUCT_JOIN}`,
      shape: "adjustment",
    },
  },
  stock_transfer: {
    table: "stock_transfers",
    select:
      "*, from_warehouse:warehouses!stock_transfers_from_warehouse_id_fkey(name), to_warehouse:warehouses!stock_transfers_to_warehouse_id_fkey(name)",
    titleField: "transfer_number",
    dateField: "transfer_date",
    statusField: "status",
    route: "/warehouse-app/warehouses",
    kind: "stock_transfer",
    lines: {
      table: "stock_transfer_items",
      fk: "transfer_id",
      select: `id, quantity_requested, quantity_sent, quantity_received, notes, uom_snapshot, ${PRODUCT_JOIN}`,
      shape: "transfer",
    },
  },
};

const fmtDate = (v?: string | null) => {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
};

const fmtDateTime = (v?: string | null) => {
  if (!v) return null;
  try {
    return format(new Date(v), "PP p");
  } catch {
    return v;
  }
};

const num = (v: unknown) => (v == null ? null : Number(v));
const qty = (v: unknown) => {
  const n = num(v);
  return n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
};
const uomOf = (row: any) =>
  row?.uom_snapshot?.code || row?.uom_snapshot?.name || row?.uom_snapshot_base_code || null;

const productLabel = (row: any) =>
  row?.products?.name ||
  row?.product_name_snapshot ||
  row?.description ||
  "Item";

const productSub = (row: any) => {
  const bits = [
    row?.products?.sku || row?.product_sku_snapshot,
    row?.lot_number ? `Lot ${row.lot_number}` : null,
    row?.serial_number ? `S/N ${row.serial_number}` : null,
    uomOf(row),
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
};

const itemCell = (row: any) => {
  const sub = productSub(row);
  return (
    <div className="min-w-0">
      <div className="truncate font-medium">{productLabel(row)}</div>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
};

/** Column sets per line shape. */
function columnsFor(shape: LineShape): LineItemColumn[] {
  const item: LineItemColumn = {
    id: "item",
    header: "Item",
    priority: 1,
    minWidth: 180,
  };
  switch (shape) {
    case "priced":
      return [
        item,
        { id: "qty", header: "Qty", numeric: true, priority: 2, compactLabel: "Qty" },
        { id: "price", header: "Unit price", numeric: true, priority: 3, compactLabel: "Price" },
        { id: "total", header: "Amount", numeric: true, priority: 1 },
      ];
    case "shipment":
      return [
        item,
        { id: "ordered", header: "Ordered", numeric: true, priority: 3, compactLabel: "Ordered" },
        { id: "delivered", header: "Delivered", numeric: true, priority: 1 },
      ];
    case "adjustment":
      return [
        item,
        { id: "before", header: "Before", numeric: true, priority: 3, compactLabel: "Before" },
        { id: "change", header: "Change", numeric: true, priority: 1 },
        { id: "after", header: "After", numeric: true, priority: 2, compactLabel: "After" },
      ];
    case "transfer":
      return [
        item,
        { id: "requested", header: "Requested", numeric: true, priority: 3, compactLabel: "Req." },
        { id: "sent", header: "Sent", numeric: true, priority: 1 },
        { id: "received", header: "Received", numeric: true, priority: 2, compactLabel: "Rcvd" },
      ];
  }
}

function rowsFor(
  shape: LineShape,
  lines: any[],
  formatCurrency: (v: number) => string,
): LineItemRow[] {
  return lines.map((line) => {
    const cells: LineItemRowCell[] = [{ columnId: "item", content: itemCell(line) }];
    if (shape === "priced") {
      const unit = num(line.unit_price);
      const total = num(line.line_total);
      cells.push(
        { columnId: "qty", content: qty(line.quantity) },
        { columnId: "price", content: unit == null ? "—" : formatCurrency(unit) },
        { columnId: "total", content: total == null ? "—" : formatCurrency(total) },
      );
    } else if (shape === "shipment") {
      cells.push(
        { columnId: "ordered", content: qty(line.quantity_ordered) },
        { columnId: "delivered", content: qty(line.quantity_delivered ?? line.quantity_received) },
      );
    } else if (shape === "adjustment") {
      const change = num(line.quantity_adjustment);
      cells.push(
        { columnId: "before", content: qty(line.quantity_before) },
        {
          columnId: "change",
          content: (
            <span className={change != null && change < 0 ? "text-destructive" : undefined}>
              {change != null && change > 0 ? "+" : ""}
              {qty(change)}
            </span>
          ),
        },
        { columnId: "after", content: qty(line.quantity_after) },
      );
    } else {
      cells.push(
        { columnId: "requested", content: qty(line.quantity_requested) },
        { columnId: "sent", content: qty(line.quantity_sent) },
        { columnId: "received", content: qty(line.quantity_received) },
      );
    }
    return { id: line.id, cells };
  });
}

/** Header facts, per reference type. */
function detailsFor(
  referenceType: string,
  doc: any,
  contactName: string | null,
): DetailField[] {
  const f: DetailField[] = [];
  const push = (label: string, value: unknown) => {
    if (value == null || value === "") return;
    f.push({ label, value: value as any });
  };

  switch (referenceType) {
    case "delivery_note": {
      push("Customer", contactName);
      push(
        "Ship to",
        doc.ship_to?.company_name || doc.ship_to?.name || doc.shipping_address,
      );
      push("Warehouse", doc.warehouses?.name);
      push("Sales order", doc.sales_orders?.order_number);
      push(
        "Invoice",
        doc.source_invoice?.invoice_number || doc.spawned_invoice?.invoice_number,
      );
      push("Shipping method", doc.shipping_method);
      push("Carrier / route", doc.dispatch_route);
      push("Driver", doc.driver_name);
      push("Vehicle", doc.vehicle_number);
      push("Tracking", doc.tracking_number);
      push("Dispatched", fmtDateTime(doc.dispatched_at));
      push("Delivered", fmtDateTime(doc.delivered_at));
      push("Received by", doc.received_by);
      if (doc.is_return) push("Type", "Return delivery");
      if (doc.is_backorder) push("Type", "Backorder shipment");
      break;
    }
    case "stock_adjustment": {
      push("Type", doc.adjustment_type);
      push("Reason", doc.reason);
      push("Warehouse", doc.warehouses?.name);
      push("Approved", fmtDateTime(doc.approved_at));
      push("Reversal reason", doc.reversal_reason);
      if (doc.reverses_adjustment_id) push("Nature", "Reversal of a prior adjustment");
      break;
    }
    case "stock_transfer": {
      push("From", doc.from_warehouse?.name);
      push("To", doc.to_warehouse?.name);
      push("Expected arrival", doc.expected_arrival_date && fmtDate(doc.expected_arrival_date));
      push("Actual arrival", doc.actual_arrival_date && fmtDate(doc.actual_arrival_date));
      push("Approved", fmtDateTime(doc.approved_at));
      push("Completed", fmtDateTime(doc.completed_at));
      break;
    }
    case "goods_receipt": {
      push("Purchase order", doc.purchase_orders?.order_number);
      push("Warehouse", doc.warehouses?.name);
      break;
    }
    case "pos_transaction": {
      push("Customer", doc.customer_name);
      push("Type", doc.transaction_type);
      push("Payment", doc.payment_status);
      push("Completed", fmtDateTime(doc.completed_at));
      break;
    }
    default: {
      push("Contact", contactName);
      break;
    }
  }

  push("Notes", doc.notes);
  return f;
}

export function SourceDocumentPeekSheet({
  open,
  onOpenChange,
  referenceType,
  referenceId,
}: SourceDocumentPeekSheetProps) {
  const { formatCurrency } = useCurrency();
  const config = referenceType ? DOC_CONFIG[referenceType] : null;

  const { data: document, isLoading } = useQuery({
    queryKey: ["source-doc-drawer", referenceType, referenceId],
    queryFn: async () => {
      if (!config || !referenceId) return null;
      const { data, error } = await supabase
        .from(config.table as any)
        .select(config.select)
        .eq("id", referenceId)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
    enabled: !!config && !!referenceId && open,
  });

  const { data: lines } = useQuery({
    queryKey: ["source-doc-drawer-lines", referenceType, referenceId],
    queryFn: async () => {
      const spec = config?.lines;
      if (!spec || !referenceId) return [];
      let q = supabase
        .from(spec.table as any)
        .select(spec.select)
        .eq(spec.fk, referenceId);
      if (spec.orderBy) q = q.order(spec.orderBy, { ascending: true });
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as any[];
    },
    enabled: !!config?.lines && !!referenceId && open,
  });

  const view = useMemo<DocumentRecordView>(() => {
    const docTitle =
      document?.[config?.titleField || ""] || referenceType || "Document";
    const docDate = config?.dateField ? document?.[config.dateField] : null;
    const docStatus = config?.statusField ? document?.[config.statusField] : null;
    const docTotal = config?.totalField ? document?.[config.totalField] : null;
    const contact = config?.contactField ? document?.[config.contactField] : null;
    const contactName = contact?.company_name || contact?.name || null;
    const shape = config?.lines?.shape;

    const lineRows =
      shape && lines ? rowsFor(shape, lines, formatCurrency) : undefined;

    const adjustmentValue =
      shape === "adjustment" && lines
        ? lines.reduce(
            (sum, l) =>
              sum + (num(l.quantity_adjustment) ?? 0) * (num(l.unit_cost) ?? 0),
            0,
          )
        : null;

    return {
      kind: config?.kind ?? "generic",
      documentId: document?.id,
      eyebrow: referenceType
        ? referenceType.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
        : "Document",
      listPath: config?.route ?? "/",
      title: contactName || docTitle,
      docNumber: config?.titleField ? document?.[config.titleField] : undefined,
      status: docStatus,
      loading: isLoading,
      notFound: !isLoading && !!referenceId && !document,
      meta: document ? (
        <>
          {docDate && <span>{fmtDate(docDate)}</span>}
          {docTotal != null && (
            <span className="tabular-nums">{formatCurrency(docTotal)}</span>
          )}
          {lineRows && <span>{lineRows.length} line{lineRows.length === 1 ? "" : "s"}</span>}
        </>
      ) : undefined,
      detailFields:
        document && referenceType
          ? detailsFor(referenceType, document, contactName)
          : undefined,
      detailsTitle: "Document details",
      lineColumns: shape ? columnsFor(shape) : undefined,
      lineRows,
      lineEmpty: "No lines recorded on this document.",
      money:
        document && docTotal != null
          ? {
              subtotal: num(document.subtotal),
              tax: num(document.tax_amount),
              discount: num(document.discount_amount),
              total: num(docTotal),
              paid: num(document.amount_paid),
            }
          : undefined,
      totalsRows:
        adjustmentValue != null && adjustmentValue !== 0
          ? [{ label: "Net value impact", value: formatCurrency(adjustmentValue) }]
          : undefined,
      lifecycle:
        config?.lifecycle && document?.id
          ? { docType: config.lifecycle, docId: document.id }
          : undefined,
    };
  }, [config, document, formatCurrency, isLoading, lines, referenceId, referenceType]);

  return (
    <PeekScaffold
      {...view}
      open={open}
      onOpenChange={onOpenChange}
      fullPageHref={
        referenceId && config?.recordPath
          ? config.recordPath(referenceId)
          : config?.route && referenceId
            ? `${config.route}?selected=${referenceId}`
            : undefined
      }
    />
  );
}

export default SourceDocumentPeekSheet;
