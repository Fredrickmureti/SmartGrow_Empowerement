/**
 * vendorCreditNoteView — the one description of a Vendor Credit Note.
 *
 * Mirrors invoiceView: the record page and the list peek both consume this
 * builder so "what a vendor credit note looks like" is decided in one
 * place.
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
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";
import type { VendorCreditNote } from "@/hooks/useVendorCreditNotes";
import { VendorCreditNoteLinkedRecords } from "./VendorCreditNoteLinkedRecords";
import { originLabel, reasonCodeLabel } from "./vendorCreditNoteLineage";
import { useVendorCreditNoteRecord } from "./useVendorCreditNoteRecord";


function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
}

/** snake_case server state → human label, e.g. "partially_applied" → "Partially applied". */
function prettyState(v: string | null | undefined) {
  if (!v) return "—";
  const s = v.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}


const COLUMNS: LineItemColumn[] = [
  { id: "description", header: "Description", priority: 1, minWidth: 200 },
  { id: "qty", header: "Qty", numeric: true, priority: 2, minWidth: 70, compactLabel: "Qty" },
  { id: "unit", header: "Unit price", numeric: true, priority: 2, minWidth: 110, compactLabel: "@" },
  { id: "tax", header: "Tax %", numeric: true, priority: 3, minWidth: 80, compactLabel: "Tax" },
  { id: "total", header: "Subtotal", numeric: true, priority: 1, minWidth: 110 },
];

interface Result {
  creditNote: VendorCreditNote | null;
  loading: boolean;
  error: string | null;
  view: DocumentRecordView;
  refresh: () => void;
}

export function useVendorCreditNoteView(
  id: string | null | undefined,
  formatCurrency: (v: number) => string,
): Result {
  const { record: creditNote, loading, error, refetch } = useVendorCreditNoteRecord(id);

  const view = useMemo<DocumentRecordView>(() => {
    const items = ((creditNote as any)?.items ?? []) as any[];
    const rows: LineItemRow[] = items
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

    const remaining = creditNote
      ? Math.max(0, (creditNote.total ?? 0) - ((creditNote as any).amount_applied ?? 0))
      : 0;

    return {
      kind: "vendor_credit_note",
      documentId: creditNote?.id,
      eyebrow: "Vendor Credit Note",
      listPath: "/purchases/credit-notes",
      title: creditNote?.vendor?.name ?? "Vendor",
      docNumber: creditNote?.credit_note_number,
      status: creditNote?.status,
      loading,
      error,
      notFound: !loading && !error && !creditNote,
      meta: creditNote ? (
        <>
          <span>Dated {fmtDate(creditNote.credit_date)}</span>
          <span className="tabular-nums">
            {formatCurrency(creditNote.total ?? 0)} {creditNote.currency}
          </span>
          {creditNote.bill?.bill_number && (
            <span>
              Bill{" "}
              <Link className="underline" to="/purchases/bills">
                {creditNote.bill.bill_number}
              </Link>
            </span>
          )}
        </>
      ) : undefined,
      balanceLabel: "Remaining",
      totalsRows: creditNote
        ? [
            { label: "Subtotal", value: formatCurrency(creditNote.subtotal ?? 0) },
            { label: "Tax", value: formatCurrency(creditNote.tax_amount ?? 0) },
            {
              label: "Total",
              value: formatCurrency(creditNote.total ?? 0),
              emphasized: true,
            },
            {
              label: "Applied",
              value: formatCurrency((creditNote as any).amount_applied ?? 0),
              muted: true,
            },
            {
              label: "Remaining",
              value: formatCurrency(remaining),
              emphasized: true,
            },
          ]
        : undefined,
      totalsFooter: creditNote ? `Currency ${creditNote.currency}` : undefined,
      detailFields: creditNote
        ? [
            { label: "Vendor", value: creditNote.vendor?.name ?? "—" },
            { label: "Credit date", value: fmtDate(creditNote.credit_date) },
            { label: "Linked bill", value: creditNote.bill?.bill_number ?? "—" },
            { label: "Currency", value: creditNote.currency },
            // ADR 0132: commercial, accounting and settlement states are
            // independent — surface all three rather than one blended badge.
            {
              label: "Approval",
              value: prettyState((creditNote as any).commercial_status),
            },
            {
              label: "Accounting",
              value: prettyState((creditNote as any).accounting_status),
            },
            {
              label: "Settlement",
              value: prettyState((creditNote as any).settlement_status),
            },
            {
              label: "Origin",
              value: originLabel((creditNote as any).origin),
            },
            ...((creditNote as any).reason_code
              ? [
                  {
                    label: "Reason",
                    value: reasonCodeLabel((creditNote as any).reason_code),
                  },
                ]
              : []),
            ...((creditNote as any).vendor_document_number
              ? [
                  {
                    label: "Vendor document",
                    value: String((creditNote as any).vendor_document_number),
                  },
                ]
              : []),
            ...((creditNote as any).vendor_document_date
              ? [
                  {
                    label: "Vendor document date",
                    value: fmtDate((creditNote as any).vendor_document_date),
                  },
                ]
              : []),
            // A supplier dispute is counterparty behaviour, not an internal
            // rejection — its outcome is part of the audit trail.
            ...((creditNote as any).disputed_at
              ? [
                  {
                    label: "Dispute",
                    value: (creditNote as any).dispute_resolved_at
                      ? `Resolved — ${prettyState(
                          (creditNote as any).dispute_resolution ?? "closed",
                        )}`
                      : `Open since ${fmtDate((creditNote as any).disputed_at)}`,
                  },
                ]
              : []),
            ...((creditNote as any).dispute_reason
              ? [
                  {
                    label: "Dispute reason",
                    value: String((creditNote as any).dispute_reason),
                  },
                ]
              : []),
          ]
        : undefined,

      lineColumns: COLUMNS,
      lineRows: rows,
      lineEmpty: "No line items on this credit note.",
      extraSections: creditNote ? (
        <>
          <VendorCreditNoteLinkedRecords creditNote={creditNote} />
          {creditNote.notes && (
            <Section title="Notes">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {creditNote.notes}
              </p>
            </Section>
          )}
          <DocumentVersionsSection
            documentType="vendor_credit_note"
            documentId={creditNote.id}
          />
        </>
      ) : undefined,

    };
  }, [creditNote, loading, error, formatCurrency]);

  return { creditNote, loading, error, view, refresh: refetch };
}
