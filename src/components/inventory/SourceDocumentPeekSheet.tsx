/**
 * SourceDocumentPeekSheet — the drawer projection of a generic "source
 * document" reference (PO, invoice, bill, sales order, POS transaction,
 * stock adjustment, stock transfer).
 *
 * This used to be a hand-rolled `DetailSheet` with its own status badge and
 * ad-hoc field grid. It is now a `DocumentRecordView` descriptor projected
 * through `PeekScaffold`, like every other document peek.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";

import { PeekScaffold } from "@/design-system/records";
import type { DocumentRecordView } from "@/design-system/records";
import type { DocumentKind } from "@/design-system/records/documentStatus";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";

interface SourceDocumentPeekSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  referenceType: string | null;
  referenceId: string | null;
}

const DOC_CONFIG: Record<string, {
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
}> = {

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
  },
  sales_order: {
    table: "sales_orders",
    select: "*, contacts(company_name, name)",
    titleField: "order_number",
    dateField: "order_date",
    statusField: "status",
    totalField: "total",
    contactField: "contacts",
    route: "/sales",
    recordPath: (id) => `/sales/orders/${id}`,
    kind: "sales_order",
  },
  delivery_note: {
    table: "delivery_notes",
    select: "*",
    titleField: "delivery_number",
    dateField: "delivery_date",
    statusField: "status",
    route: "/delivery-notes",
    recordPath: (id) => `/sales/delivery-notes/${id}`,
    kind: "delivery_note",
  },
  credit_note: {
    table: "credit_notes",
    select: "*",
    titleField: "credit_note_number",
    dateField: "issue_date",
    statusField: "status",
    totalField: "total",
    route: "/sales/credit-notes",
    recordPath: (id) => `/sales/credit-notes/${id}`,
    kind: "credit_note",
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
  },
  goods_receipt: {
    table: "goods_receipts",
    select: "*, purchase_orders(order_number)",
    titleField: "receipt_number",
    dateField: "receipt_date",
    statusField: "status",
    route: "/warehouse-app/receiving",
    kind: "generic",
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
  },
  stock_adjustment: {
    table: "stock_adjustments",
    select: "*",
    titleField: "adjustment_number",
    dateField: "adjustment_date",
    statusField: "status",
    route: "/inventory-app/stock",
    kind: "stock_adjustment",
  },
  stock_transfer: {
    table: "stock_transfers",
    select: "*, from_warehouse:warehouses!stock_transfers_from_warehouse_id_fkey(name), to_warehouse:warehouses!stock_transfers_to_warehouse_id_fkey(name)",
    titleField: "transfer_number",
    dateField: "transfer_date",
    statusField: "status",
    route: "/warehouse-app/warehouses",
    kind: "stock_transfer",
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

  const view = useMemo<DocumentRecordView>(() => {
    const docTitle =
      document?.[config?.titleField || ""] || referenceType || "Document";
    const docDate = config?.dateField ? document?.[config.dateField] : null;
    const docStatus = config?.statusField ? document?.[config.statusField] : null;
    const docTotal = config?.totalField ? document?.[config.totalField] : null;
    const contact = config?.contactField ? document?.[config.contactField] : null;
    const contactName = contact?.company_name || contact?.name || null;

    const detailFields = document
      ? [
          { label: "Date", value: docDate ? fmtDate(docDate) : "—" },
          { label: "Contact", value: contactName ?? "—" },
          ...(referenceType === "stock_transfer" && document.from_warehouse
            ? [
                { label: "From", value: document.from_warehouse.name },
                { label: "To", value: document.to_warehouse?.name ?? "—" },
              ]
            : []),
          ...(referenceType === "pos_transaction"
            ? [
                { label: "Customer", value: document.customer_name ?? "—" },
                { label: "Type", value: document.transaction_type ?? "—" },
                { label: "Payment", value: document.payment_status ?? "—" },
              ]
            : []),
          { label: "Notes", value: document.notes ?? "—" },
        ]
      : undefined;

    return {
      kind: config?.kind ?? "generic",
      documentId: document?.id,
      eyebrow: referenceType
        ? referenceType.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
        : "Document",
      listPath: config?.route ?? "/",
      title: docTitle,
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
        </>
      ) : undefined,
      detailFields,
    };
  }, [config, document, formatCurrency, isLoading, referenceId, referenceType]);

  return (
    <PeekScaffold
      {...view}
      open={open}
      onOpenChange={onOpenChange}
      fullPageHref={
        config?.route && referenceId
          ? `${config.route}?selected=${referenceId}`
          : undefined
      }
    />
  );
}

export default SourceDocumentPeekSheet;
