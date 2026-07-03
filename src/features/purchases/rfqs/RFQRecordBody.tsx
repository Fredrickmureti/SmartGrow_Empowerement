/**
 * RFQRecordBody — shared inner section stack for the full-page
 * RFQRecordPage and the peek RFQPeekSheet so peek/full parity is
 * guaranteed.
 */
import { useMemo } from "react";
import { format } from "date-fns";
import { Award } from "lucide-react";
import {
  Section,
  StatusBadge,
  LineItemsGrid,
  type LineItemColumn,
  type LineItemRow,
} from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { useCurrency } from "@/hooks/useCurrency";

const fmt = (v?: string | null) => {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
};

const VENDOR_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  pending: "neutral",
  quoted: "info",
  awarded: "success",
  declined: "danger",
};

interface Props {
  record: any;
}

export function RFQRecordBody({ record }: Props) {
  const { formatCurrency, baseCurrency } = useCurrency();

  const columns = useMemo<LineItemColumn[]>(
    () => [
      { id: "description", header: "Description", width: "minmax(0,1fr)" },
      { id: "qty", header: "Qty", width: "80px", numeric: true },
      { id: "target", header: "Target price", width: "130px", numeric: true },
      { id: "total", header: "Est. total", width: "130px", numeric: true },
    ],
    [],
  );

  const rows = useMemo<LineItemRow[]>(() => {
    const items = (record?.items ?? []) as any[];
    return items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          {
            columnId: "target",
            content:
              line.target_price != null
                ? formatCurrency(line.target_price, baseCurrency)
                : "—",
          },
          {
            columnId: "total",
            content:
              line.target_price != null
                ? formatCurrency(
                    (line.target_price ?? 0) * (line.quantity ?? 0),
                    baseCurrency,
                  )
                : "—",
          },
        ],
      }));
  }, [record, formatCurrency, baseCurrency]);

  if (!record) return null;

  const vendors = (record.vendors ?? []) as any[];

  return (
    <>
      <Section title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">RFQ #</dt>
            <dd className="mt-0.5 font-mono">{record.rfq_number}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Created</dt>
            <dd className="mt-0.5">{fmt(record.created_at)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Deadline</dt>
            <dd className="mt-0.5">{fmt(record.deadline)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Items</dt>
            <dd className="mt-0.5">{(record.items ?? []).length}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Suppliers</dt>
            <dd className="mt-0.5">{vendors.length}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Status</dt>
            <dd className="mt-0.5 capitalize">{record.status}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Requested items">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No items on this RFQ.</p>
        ) : (
          <LineItemsGrid columns={columns} rows={rows} readOnly />
        )}
      </Section>

      <Section title="Invited suppliers">
        {vendors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No suppliers were invited.
          </p>
        ) : (
          <div className="space-y-2">
            {vendors.map((v) => (
              <div
                key={v.id}
                className="flex items-center justify-between rounded-lg border p-3"
              >
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                    {v.vendor?.name?.charAt(0) ?? "?"}
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {v.vendor?.name ?? "Unknown supplier"}
                    </p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <StatusBadge tone={VENDOR_TONE[v.status] ?? "neutral"}>
                        {v.status === "awarded" && (
                          <Award className="mr-1 h-3 w-3" />
                        )}
                        {v.status}
                      </StatusBadge>
                      {v.quoted_total != null && (
                        <Badge variant="outline" className="text-xs">
                          Quoted {formatCurrency(v.quoted_total, baseCurrency)}
                        </Badge>
                      )}
                      {v.lead_time_days != null && (
                        <Badge variant="outline" className="text-xs">
                          {v.lead_time_days} days
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {record.notes && (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {record.notes}
          </p>
        </Section>
      )}
    </>
  );
}

export default RFQRecordBody;