/**
 * purchaseReturnView — the one description of a Purchase Return.
 *
 * Mirrors invoiceView: the record page and the list peek both consume this
 * builder so "what a purchase return looks like" is decided in one place.
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
import type { PurchaseReturn } from "@/hooks/usePurchaseReturns";
import { usePurchaseReturnRecord } from "./usePurchaseReturnRecord";

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

const COLUMNS: LineItemColumn[] = [
  { id: "description", header: "Description", priority: 1, minWidth: 200 },
  { id: "qty", header: "Qty", numeric: true, priority: 2, minWidth: 70, compactLabel: "Qty" },
  { id: "unit", header: "Unit price", numeric: true, priority: 2, minWidth: 110, compactLabel: "@" },
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

  const view = useMemo<DocumentRecordView>(() => {
    const items = ((purchaseReturn as any)?.items ?? []) as any[];
    const rows: LineItemRow[] = items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));

    return {
      kind: "purchase_return",
      documentId: purchaseReturn?.id,
      eyebrow: "Purchase Return",
      listPath: "/purchases/returns",
      title: purchaseReturn?.vendor?.name ?? "Vendor",
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
          {purchaseReturn.reason && <span>Reason: {purchaseReturn.reason}</span>}
        </>
      ) : undefined,
      totalsRows: purchaseReturn
        ? [
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
            { label: "Vendor", value: purchaseReturn.vendor?.name ?? "—" },
            { label: "Return date", value: fmtDate(purchaseReturn.return_date) },
            { label: "Reason", value: purchaseReturn.reason || "—" },
            { label: "Currency", value: purchaseReturn.currency ?? "—" },
          ]
        : undefined,
      lineColumns: COLUMNS,
      lineRows: rows,
      lineEmpty: "No line items on this return.",
      extraSections: purchaseReturn ? (
        <>
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
  }, [purchaseReturn, loading, error, formatCurrency]);

  return { purchaseReturn, loading, error, view, refresh: refetch };
}
