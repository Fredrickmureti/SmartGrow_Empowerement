/**
 * invoiceView — the one description of a Sales Invoice.
 *
 * The record page and the list peek previously each declared their own
 * status map, detail fields, line columns, totals ladder and activity list.
 * They now both consume this builder, so there is a single place where "what
 * an invoice looks like" is decided, and no way for the two surfaces to
 * disagree.
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
import type { Invoice } from "@/hooks/useInvoices";
import { useInvoiceRecord } from "./useInvoiceRecord";

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
  { id: "disc", header: "Disc %", numeric: true, priority: 3, minWidth: 80, compactLabel: "Disc" },
  { id: "tax", header: "Tax %", numeric: true, priority: 3, minWidth: 80, compactLabel: "Tax" },
  { id: "total", header: "Subtotal", numeric: true, priority: 1, minWidth: 110 },
];

interface Result {
  invoice: Invoice | null;
  loading: boolean;
  error: string | null;
  view: DocumentRecordView;
}

export function useInvoiceView(
  id: string | null | undefined,
  formatCurrency: (v: number) => string,
): Result {
  const { invoice, loading, error } = useInvoiceRecord(id);

  const view = useMemo<DocumentRecordView>(() => {
    const rows: LineItemRow[] = (invoice?.invoice_items ?? [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "disc", content: line.discount_percent ?? 0 },
          { columnId: "tax", content: line.tax_rate ?? 0 },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));

    return {
      kind: "invoice",
      eyebrow: "Sales Invoice",
      listPath: "/sales/invoices",
      title: invoice?.contact?.name ?? "Customer",
      docNumber: invoice?.invoice_number,
      status: invoice?.status,
      loading,
      error,
      notFound: !loading && !error && !invoice,
      meta: invoice ? (
        <>
          <span>Issued {fmtDate(invoice.issue_date)}</span>
          <span>Due {fmtDate(invoice.due_date)}</span>
          <span className="tabular-nums">
            {formatCurrency(invoice.total ?? 0)} {invoice.currency}
          </span>
        </>
      ) : undefined,
      lifecycle: invoice ? { docType: "invoice", docId: invoice.id } : undefined,
      money: invoice
        ? {
            subtotal: invoice.subtotal ?? 0,
            discount: invoice.discount_amount ?? 0,
            tax: invoice.tax_amount ?? 0,
            total: invoice.total ?? 0,
            paid: invoice.amount_paid ?? 0,
          }
        : undefined,
      totalsFooter: invoice ? `Currency ${invoice.currency}` : undefined,
      detailFields: invoice
        ? [
            { label: "Customer", value: invoice.contact?.name ?? "—" },
            { label: "Email", value: invoice.contact?.email ?? "—" },
            { label: "Phone", value: invoice.contact?.phone ?? "—" },
            { label: "Issue date", value: fmtDate(invoice.issue_date) },
            { label: "Due date", value: fmtDate(invoice.due_date) },
            { label: "Currency", value: invoice.currency },
          ]
        : undefined,
      lineColumns: COLUMNS,
      lineRows: rows,
      lineEmpty: "No line items on this invoice.",
      extraSections: invoice ? (
        <>
          {(invoice.notes || invoice.terms) && (
            <Section title="Notes & terms">
              {invoice.notes && (
                <div className="mb-3">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    Notes
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{invoice.notes}</p>
                </div>
              )}
              {invoice.terms && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    Terms
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{invoice.terms}</p>
                </div>
              )}
            </Section>
          )}
          <DocumentVersionsSection documentType="invoice" documentId={invoice.id} />
        </>
      ) : undefined,
    };
  }, [invoice, loading, error, formatCurrency]);

  return { invoice, loading, error, view };
}
