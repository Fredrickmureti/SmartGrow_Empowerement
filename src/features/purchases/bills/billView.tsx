/**
 * billView — the one description of a Bill.
 *
 * Mirrors `invoiceView`: the record page and the list peek both consume
 * this builder so "what a bill looks like" is decided in a single place.
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
import type { Bill } from "@/hooks/useBills";
import { useBillRecord } from "./useBillRecord";

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
  { id: "tax", header: "Tax %", numeric: true, priority: 3, minWidth: 80, compactLabel: "Tax" },
  { id: "total", header: "Subtotal", numeric: true, priority: 1, minWidth: 110 },
];

interface Result {
  bill: Bill | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch the bill after an action mutates it. */
  refresh: () => void;
  view: DocumentRecordView;
}

export function useBillView(
  id: string | null | undefined,
  formatCurrency: (v: number) => string,
): Result {
  const { record: bill, loading, error, refetch } = useBillRecord(id);

  const view = useMemo<DocumentRecordView>(() => {
    const balance = bill ? Math.max(0, (bill.total ?? 0) - (bill.amount_paid ?? 0)) : 0;

    const rows: LineItemRow[] = (bill?.items ?? [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "tax", content: line.tax_rate ?? 0 },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));

    return {
      kind: "bill",
      documentId: bill?.id,
      eyebrow: "Bill",
      listPath: "/purchases/bills",
      title: bill?.vendor?.name ?? "Vendor",
      docNumber: bill?.bill_number,
      status: bill?.status,
      loading,
      error,
      notFound: !loading && !error && !bill,
      meta: bill ? (
        <>
          <span>Billed {fmtDate(bill.bill_date)}</span>
          <span>Due {fmtDate(bill.due_date)}</span>
          <span className="tabular-nums">
            {formatCurrency(bill.total ?? 0)} {bill.currency}
          </span>
        </>
      ) : undefined,
      money: bill
        ? {
            subtotal: bill.subtotal ?? 0,
            discount: bill.discount_amount ?? 0,
            tax: bill.tax_amount ?? 0,
            total: bill.total ?? 0,
            paid: bill.amount_paid ?? 0,
          }
        : undefined,
      balanceLabel: "Balance due",
      totalsFooter: bill ? `Currency ${bill.currency}` : undefined,
      detailFields: bill
        ? [
            { label: "Vendor", value: bill.vendor?.name ?? "—" },
            { label: "Vendor invoice #", value: bill.vendor_invoice_number ?? "—" },
            { label: "Bill date", value: fmtDate(bill.bill_date) },
            { label: "Due date", value: fmtDate(bill.due_date) },
            {
              label: "Currency",
              value:
                bill.currency +
                (bill.currency_rate && bill.currency_rate !== 1
                  ? ` @ ${bill.currency_rate}`
                  : ""),
            },
            { label: "Balance due", value: formatCurrency(balance) },
          ]
        : undefined,
      lineColumns: COLUMNS,
      lineRows: rows,
      lineEmpty: "No line items on this bill.",
      extraSections: bill ? (
        <>
          <BillMatchPanel
            billId={bill.id}
            currency={bill.currency}
            formatCurrency={formatCurrency}
          />
          {bill.notes && (
            <Section title="Notes">
              <p className="whitespace-pre-wrap text-sm">{bill.notes}</p>
            </Section>
          )}
          <DocumentVersionsSection documentType="bill" documentId={bill.id} />
        </>
      ) : undefined,

    };
  }, [bill, loading, error, formatCurrency]);

  return { bill, loading, error, refresh: refetch, view };
}
