/**
 * estimateView — the one description of a Sales Estimate, shared by the
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
import type { Estimate } from "@/hooks/useEstimates";
import { useEstimateRecord } from "./useEstimateRecord";

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
  { id: "unit", header: "Unit price", numeric: true, priority: 2, minWidth: 110, compactLabel: "@" },
  { id: "disc", header: "Disc %", numeric: true, priority: 3, minWidth: 80, compactLabel: "Disc" },
  { id: "tax", header: "Tax %", numeric: true, priority: 3, minWidth: 80, compactLabel: "Tax" },
  { id: "total", header: "Subtotal", numeric: true, priority: 1, minWidth: 110 },
];

interface Result {
  estimate: Estimate | null;
  loading: boolean;
  error: string | null;
  view: DocumentRecordView;
}

export function useEstimateView(
  id: string | null | undefined,
  formatCurrency: (v: number) => string,
): Result {
  const { record, loading, error } = useEstimateRecord(id);
  const estimate = record ?? null;

  const view = useMemo<DocumentRecordView>(() => {
    const rows: LineItemRow[] = (estimate?.items ?? [])
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
      kind: "estimate",
      documentId: estimate?.id,
      eyebrow: "Sales Estimate",
      listPath: "/sales/estimates",
      title: estimate?.contact?.name ?? "Customer",
      docNumber: estimate?.estimate_number,
      status: estimate?.status,
      loading,
      error,
      notFound: !loading && !error && !estimate,
      meta: estimate ? (
        <>
          <span>Issued {fmt(estimate.issue_date)}</span>
          <span>Expires {fmt(estimate.expiry_date)}</span>
          <span className="tabular-nums">
            {formatCurrency(estimate.total ?? 0)} {estimate.currency}
          </span>
        </>
      ) : undefined,
      lifecycle: estimate ? { docType: "estimate", docId: estimate.id } : undefined,
      money: estimate
        ? {
            subtotal: estimate.subtotal ?? 0,
            discount: estimate.discount_amount ?? 0,
            tax: estimate.tax_amount ?? 0,
            total: estimate.total ?? 0,
          }
        : undefined,
      totalsFooter: estimate ? `Currency ${estimate.currency}` : undefined,
      detailFields: estimate
        ? [
            { label: "Customer", value: estimate.contact?.name ?? "—" },
            { label: "Email", value: estimate.contact?.email ?? "—" },
            { label: "Issue date", value: fmt(estimate.issue_date) },
            { label: "Expiry date", value: fmt(estimate.expiry_date) },
            { label: "Currency", value: estimate.currency },
          ]
        : undefined,
      lineColumns: COLUMNS,
      lineRows: rows,
      lineEmpty: "No line items on this estimate.",
      extraSections: estimate ? (
        <>
          {(estimate.notes || estimate.terms) && (
            <Section title="Notes & terms">
              {estimate.notes && (
                <div className="mb-3">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    Notes
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{estimate.notes}</p>
                </div>
              )}
              {estimate.terms && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    Terms
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{estimate.terms}</p>
                </div>
              )}
            </Section>
          )}
          <DocumentVersionsSection documentType="estimate" documentId={estimate.id} />
        </>
      ) : undefined,
      activityExtra: estimate
        ? [
            ...(estimate.signed_at
              ? [
                  {
                    id: "signed",
                    at: fmt(estimate.signed_at),
                    title: `Signed by ${estimate.signed_by_name ?? "customer"}`,
                    tone: "success" as const,
                  },
                ]
              : []),
            ...(estimate.converted_at
              ? [
                  {
                    id: "converted",
                    at: fmt(estimate.converted_at),
                    title: "Converted to invoice",
                    tone: "info" as const,
                  },
                ]
              : []),
          ]
        : undefined,
    };
  }, [estimate, loading, error, formatCurrency]);

  return { estimate, loading, error, view };
}
