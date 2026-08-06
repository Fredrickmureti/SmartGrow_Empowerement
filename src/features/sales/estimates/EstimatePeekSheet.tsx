/**
 * EstimatePeekSheet — the standard Sales list peek surface for one estimate.
 * Read-oriented: quote lifecycle actions (send, convert, delete) stay in the
 * parent list row menu. Opens from `?peek=<id>` via usePeekParam.
 */
import { useMemo } from "react";
import { format } from "date-fns";
import { Section, StatusBadge } from "@/design-system";
import {
  DocumentActivityPanel,
  DocumentPeekShell,
  DocumentTotalsPanel,
  LineItemsGrid,
  type LineItemColumn,
  type LineItemRow,
} from "@/design-system/records";
import { useCurrency } from "@/hooks/useCurrency";
import type { Estimate } from "@/hooks/useEstimates";
import { useEstimateRecord } from "./useEstimateRecord";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

type Status = Estimate["status"];
const TONE: Record<Status, "neutral" | "info" | "success" | "warning" | "danger" | "accent"> = {
  draft: "neutral",
  sent: "info",
  viewed: "accent",
  accepted: "success",
  rejected: "danger",
  expired: "warning",
  converted: "success",
};
const LABEL: Record<Status, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  accepted: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
  converted: "Converted",
};

const fmt = (v?: string | null) => {
  if (!v) return "—";
  try { return format(new Date(v), "PP"); } catch { return v; }
};

interface Props { estimateId: string | null; onOpenChange: (o: boolean) => void; }

export function EstimatePeekSheet({ estimateId, onOpenChange }: Props) {
  const { record, loading, error } = useEstimateRecord(estimateId);
  const { formatCurrency } = useCurrency();

  const columns = useMemo<LineItemColumn[]>(() => [
    { id: "description", header: "Description", width: "minmax(0,1fr)" },
    { id: "qty", header: "Qty", width: "64px", numeric: true },
    { id: "unit", header: "Unit", width: "110px", numeric: true },
    { id: "total", header: "Subtotal", width: "120px", numeric: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const items = record?.items ?? [];
    return items.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          { columnId: "unit", content: formatCurrency(line.unit_price ?? 0) },
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));
  }, [record, formatCurrency]);

  return (
    <DocumentPeekShell
      open={!!estimateId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load estimate"
      title={loading ? "Loading estimate…" : record ? `Estimate ${record.estimate_number}` : "Estimate"}
      description={record ? (
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={TONE[record.status]}>{LABEL[record.status]}</StatusBadge>
          <span className="text-muted-foreground">{record.contact?.name ?? "Customer"}</span>
        </span>
      ) : undefined}
      fullPageHref={record ? `/sales/estimates/${record.id}` : undefined}
    >
      {record && (
        <div className="space-y-5">
          <Section title="Details">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs font-medium text-muted-foreground">Customer</dt><dd className="mt-0.5">{record.contact?.name ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Email</dt><dd className="mt-0.5">{record.contact?.email ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Issue date</dt><dd className="mt-0.5">{fmt(record.issue_date)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Expiry</dt><dd className="mt-0.5">{fmt(record.expiry_date)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Currency</dt><dd className="mt-0.5">{record.currency}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Total</dt><dd className="mt-0.5 tabular-nums">{formatCurrency(record.total ?? 0)}</dd></div>
            </dl>
          </Section>
          <Section title="Totals">
            <DocumentTotalsPanel rows={[
              { label: "Subtotal", value: formatCurrency(record.subtotal ?? 0) },
              { label: "Discount", value: `- ${formatCurrency(record.discount_amount ?? 0)}`, muted: true },
              { label: "Tax", value: formatCurrency(record.tax_amount ?? 0) },
              { label: "Total", value: formatCurrency(record.total ?? 0), emphasized: true },
            ]} footer={`Currency ${record.currency}`} />
          </Section>
          <Section title="Line items"><LineItemsGrid columns={columns} rows={rows} readOnly /></Section>
          <Section title="Activity">
            <DocumentActivityPanel entries={[
              { id: "created", at: fmt(record.created_at), actor: "System", title: `Estimate ${record.estimate_number} created` },
              ...(record.converted_at ? [{ id: "converted", at: fmt(record.converted_at), title: "Converted to invoice", tone: "success" as const }] : []),
            ]} />
          </Section>
          <DocumentVersionsSection documentType="estimate" documentId={estimateId} />
        </div>
      )}
    </DocumentPeekShell>
  );
}
