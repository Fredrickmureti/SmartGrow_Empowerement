/**
 * PurchaseOrderPeekSheet — standard peek surface for one PO.
 * Row-click on the Purchase Orders list opens this sheet with
 * `?peek=<id>`. Header has an "Open full page" affordance to the
 * record page.
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
import { usePurchaseOrderRecord } from "./usePurchaseOrderRecord";

const TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  draft: "neutral",
  sent: "info",
  partial_received: "warning",
  received: "success",
  cancelled: "danger",
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
  poId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function PurchaseOrderPeekSheet({ poId, onOpenChange }: Props) {
  const { record, loading, error } = usePurchaseOrderRecord(poId);
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

  return (
    <DocumentPeekShell
      open={!!poId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load purchase order"
      fullPageHref={record ? `/purchases/orders/${record.id}` : undefined}
      title={
        loading
          ? "Loading purchase order…"
          : record
            ? `Purchase Order ${record.po_number}`
            : "Purchase Order"
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
                <dt className="text-xs font-medium text-muted-foreground">Order date</dt>
                <dd className="mt-0.5">{fmt(record.order_date)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Expected date</dt>
                <dd className="mt-0.5">{fmt(record.expected_date)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Currency</dt>
                <dd className="mt-0.5">{record.currency}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Total</dt>
                <dd className="mt-0.5 tabular-nums">{formatCurrency(record.total ?? 0)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Billing</dt>
                <dd className="mt-0.5">{label(record.billing_status ?? "no")}</dd>
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
                  title: `Purchase order ${record.po_number} created`,
                },
              ]}
            />
          </Section>
        </div>
      )}
    </DocumentPeekShell>
  );
}

export default PurchaseOrderPeekSheet;
