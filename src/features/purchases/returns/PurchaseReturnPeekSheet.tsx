/**
 * PurchaseReturnPeekSheet — standard peek surface for one purchase
 * return. Mirrors the Sales `SalesReturnPeekSheet` so the entire ERP
 * presents return documents the same way. Approve / process actions
 * stay on the list row menu.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Pencil } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import { usePurchaseReturnRecord } from "./usePurchaseReturnRecord";


const TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  pending: "neutral",
  approved: "info",
  processed: "success",
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
  returnId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function PurchaseReturnPeekSheet({ returnId, onOpenChange }: Props) {
  const { record, loading, error } = usePurchaseReturnRecord(returnId);
  const { formatCurrency } = useCurrency();

  const columns = useMemo<LineItemColumn[]>(
    () => [
      { id: "description", header: "Description", width: "minmax(0,1fr)" },
      { id: "qty", header: "Qty", width: "64px", numeric: true },
      { id: "unit", header: "Unit", width: "110px", numeric: true },
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
          { columnId: "total", content: formatCurrency(line.line_total ?? 0) },
        ],
      }));
  }, [record, formatCurrency]);

  return (
    <DocumentPeekShell
      open={!!returnId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load purchase return"
      extraHeaderActions={
        record && record.status === "pending" ? (
          <Button asChild size="sm" variant="outline">
            <Link
              to={`/purchases/returns/${record.id}/edit`}
              onClick={() => onOpenChange(false)}
            >
              <Pencil className="mr-1.5 h-4 w-4" /> Edit
            </Link>
          </Button>
        ) : undefined
      }
      title={
        loading
          ? "Loading purchase return…"
          : record
            ? `Return ${record.return_number}`
            : "Purchase Return"
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
                <dt className="text-xs font-medium text-muted-foreground">
                  Vendor
                </dt>
                <dd className="mt-0.5">{record.vendor?.name ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Return date
                </dt>
                <dd className="mt-0.5">{fmt(record.return_date)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Reason
                </dt>
                <dd className="mt-0.5">{record.reason || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Currency
                </dt>
                <dd className="mt-0.5">{record.currency ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Total
                </dt>
                <dd className="mt-0.5 tabular-nums">
                  {formatCurrency(record.total ?? 0)}
                </dd>
              </div>
            </dl>
          </Section>
          <Section title="Totals">
            <DocumentTotalsPanel
              rows={[
                {
                  label: "Total",
                  value: formatCurrency(record.total ?? 0),
                  emphasized: true,
                },
              ]}
              footer={record.currency ? `Currency ${record.currency}` : undefined}
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
                  title: `Return ${record.return_number} created`,
                },
              ]}
            />
          </Section>
        </div>
      )}
    </DocumentPeekShell>
  );
}

export default PurchaseReturnPeekSheet;
