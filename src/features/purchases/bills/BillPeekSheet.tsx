/**
 * BillPeekSheet — standard peek surface for one Bill.
 * Mirrors the Sales `InvoicePeekSheet` so the whole ERP presents
 * business documents identically. Row click on the Bills list opens
 * this sheet with `?peek=<id>`; the sheet header provides an
 * "Open full page" affordance to the read-only record page.
 */
import { useMemo } from "react";
import { format } from "date-fns";
import {
  Section,
  StatusBadge,
  DocumentActivityPanel,
  DocumentPeekShell,
  DocumentTotalsPanel,
  LineItemsGrid,
  type LineItemColumn,
  type LineItemRow,
} from "@/design-system";
import { useCurrency } from "@/hooks/useCurrency";
import { useBillRecord } from "./useBillRecord";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

const TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  draft: "neutral",
  received: "info",
  partial: "warning",
  paid: "success",
  overdue: "danger",
  void: "neutral",
};

const label = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const fmt = (v?: string | null) => {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
};

interface Props {
  billId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function BillPeekSheet({ billId, onOpenChange }: Props) {
  const { record, loading, error } = useBillRecord(billId);
  const { formatCurrency } = useCurrency();

  const columns = useMemo<LineItemColumn[]>(
    () => [
      { id: "description", header: "Description", width: "minmax(0,1fr)" },
      { id: "qty", header: "Qty", width: "64px", numeric: true },
      { id: "unit", header: "Unit", width: "110px", numeric: true },
      { id: "tax", header: "Tax %", width: "80px", numeric: true, hideOnMobile: true },
      { id: "total", header: "Subtotal", width: "120px", numeric: true },
    ],
    [],
  );

  const rows = useMemo<LineItemRow[]>(() => {
    const items = ((record as any)?.items ?? []) as any[];
    return items
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
  }, [record, formatCurrency]);

  const balance = record
    ? Math.max(0, (record.total ?? 0) - (record.amount_paid ?? 0))
    : 0;

  return (
    <DocumentPeekShell
      open={!!billId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load bill"
      fullPageHref={record ? `/purchases/bills/${record.id}` : undefined}
      title={
        loading
          ? "Loading bill…"
          : record
            ? `Bill ${record.bill_number}`
            : "Bill"
      }
      description={
        record ? (
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={TONE[record.status] ?? "neutral"}>
              {label(record.status)}
            </StatusBadge>
            <span className="text-muted-foreground">
              {record.vendor?.name ?? "Vendor"}
            </span>
          </span>
        ) : undefined
      }
    >
      {record && (
        <div className="space-y-5">
          <Section title="Details">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Vendor</dt>
                <dd className="mt-0.5">{record.vendor?.name ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Vendor invoice #</dt>
                <dd className="mt-0.5">{record.vendor_invoice_number ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Bill date</dt>
                <dd className="mt-0.5">{fmt(record.bill_date)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Due date</dt>
                <dd className="mt-0.5">{fmt(record.due_date)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Currency</dt>
                <dd className="mt-0.5">{record.currency}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Balance due</dt>
                <dd className="mt-0.5 tabular-nums">{formatCurrency(balance)}</dd>
              </div>
            </dl>
          </Section>
          <Section title="Totals">
            <DocumentTotalsPanel
              rows={[
                { label: "Subtotal", value: formatCurrency(record.subtotal ?? 0) },
                { label: "Discount", value: `- ${formatCurrency(record.discount_amount ?? 0)}`, muted: true },
                { label: "Tax", value: formatCurrency(record.tax_amount ?? 0) },
                { label: "Total", value: formatCurrency(record.total ?? 0), emphasized: true },
                { label: "Paid", value: formatCurrency(record.amount_paid ?? 0), muted: true },
                { label: "Balance due", value: formatCurrency(balance), emphasized: true },
              ]}
              footer={`Currency ${record.currency}`}
            />
          </Section>
          <Section title="Line items">
            <LineItemsGrid columns={columns} rows={rows} readOnly />
          </Section>
          {record.notes && (
            <Section title="Notes">
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {record.notes}
              </p>
            </Section>
          )}
          <Section title="Activity">
            <DocumentActivityPanel
              entries={[
                {
                  id: "created",
                  at: fmt(record.created_at),
                  actor: "System",
                  title: `Bill ${record.bill_number} created`,
                },
              ]}
            />
          </Section>
          <DocumentVersionsSection documentType="bill" documentId={billId} />
        </div>
      )}
    </DocumentPeekShell>
  );
}

export default BillPeekSheet;
