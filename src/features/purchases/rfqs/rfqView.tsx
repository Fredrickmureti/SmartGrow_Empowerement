/**
 * rfqView — the one description of an RFQ, shared by the peek and the
 * full record page.
 */
import { useMemo } from "react";
import { format } from "date-fns";
import { Award, ArrowRightLeft } from "lucide-react";

import type {
  DocumentRecordView,
  LineItemColumn,
  LineItemRow,
} from "@/design-system/records";
import { Section, StatusBadge } from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import { useRFQs, type RFQWithRelations } from "@/hooks/useRFQs";
import { useRFQRecord } from "./useRFQRecord";

const fmt = (v?: string | null) => {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
};

const label = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const VENDOR_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  pending: "neutral",
  quoted: "info",
  awarded: "success",
  declined: "danger",
};

type RFQRecord = RFQWithRelations & { vendors?: any[]; items?: any[] };

interface Result {
  rfq: RFQRecord | null;
  loading: boolean;
  error: string | null;
  view: DocumentRecordView;
}

export function useRFQView(
  id: string | null | undefined,
  formatCurrency: (v: number, currency?: string) => string,
): Result {
  const { record, loading, error } = useRFQRecord(id);
  const { baseCurrency } = useCurrency();
  const { convertToPurchaseOrder } = useRFQs();
  const rfq = (record as RFQRecord | undefined) ?? null;

  const columns = useMemo<LineItemColumn[]>(
    () => [
      { id: "description", header: "Description", priority: 1, minWidth: 200 },
      { id: "qty", header: "Qty", numeric: true, priority: 1, minWidth: 70, compactLabel: "Qty" },
      { id: "target", header: "Target price", numeric: true, priority: 2, minWidth: 120 },
      { id: "total", header: "Est. total", numeric: true, priority: 2, minWidth: 120 },
    ],
    [],
  );

  const view = useMemo<DocumentRecordView>(() => {
    const items = (rfq?.items ?? []) as any[];
    const vendors = (rfq?.vendors ?? []) as any[];

    const rows: LineItemRow[] = items
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

    const estimatedTotal = items.reduce(
      (s, i) => s + (i.target_price ?? 0) * (i.quantity ?? 0),
      0,
    );

    return {
      kind: "rfq",
      documentId: rfq?.id,
      eyebrow: "Request for Quotation",
      listPath: "/purchases/rfqs",
      title: rfq?.rfq_number ?? "RFQ",
      docNumber: rfq ? `${vendors.length} suppliers · ${items.length} items` : undefined,
      status: rfq?.status,
      loading,
      error,
      notFound: !loading && !error && !rfq,
      meta: rfq ? (
        <>
          <span>Created {fmt(rfq.created_at)}</span>
          {rfq.deadline && <span>Deadline {fmt(rfq.deadline)}</span>}
          {estimatedTotal > 0 && (
            <span className="tabular-nums">
              Est. {formatCurrency(estimatedTotal, baseCurrency)}
            </span>
          )}
        </>
      ) : undefined,
      totalsRows: rfq
        ? [
            { label: "Items", value: String(items.length) },
            { label: "Suppliers", value: String(vendors.length) },
            {
              label: "Estimated value",
              value: formatCurrency(estimatedTotal, baseCurrency),
              emphasized: true,
            },
          ]
        : undefined,
      totalsFooter: rfq ? `Currency ${baseCurrency}` : undefined,
      detailFields: rfq
        ? [
            { label: "RFQ #", value: rfq.rfq_number },
            { label: "Created", value: fmt(rfq.created_at) },
            { label: "Deadline", value: fmt(rfq.deadline) },
            { label: "Items", value: String(items.length) },
            { label: "Suppliers", value: String(vendors.length) },
            { label: "Status", value: label(rfq.status) },
          ]
        : undefined,
      lineColumns: columns,
      lineRows: rows,
      lineEmpty: "No items on this RFQ.",
      extraSections: rfq ? (
        <>
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
          {rfq.notes && (
            <Section title="Notes">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {rfq.notes}
              </p>
            </Section>
          )}
        </>
      ) : undefined,
      extraAside:
        rfq && rfq.status === "received" ? (
          <Section title="Award">
            <div className="space-y-2">
              {vendors.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between rounded-md border p-2 text-sm"
                >
                  <span className="truncate">{v.vendor?.name ?? "—"}</span>
                  {v.status !== "awarded" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        convertToPurchaseOrder({
                          rfqId: rfq.id,
                          rfqVendorId: v.id,
                        })
                      }
                    >
                      <ArrowRightLeft className="mr-1 h-3 w-3" />
                      Convert to PO
                    </Button>
                  ) : (
                    <StatusBadge tone="success">
                      <Award className="mr-1 h-3 w-3" /> Awarded
                    </StatusBadge>
                  )}
                </div>
              ))}
            </div>
          </Section>
        ) : undefined,
      activity: rfq
        ? [
            {
              id: "created",
              at: fmt(rfq.created_at),
              actor: "System",
              title: `RFQ ${rfq.rfq_number} created`,
            },
            ...(rfq.status === "sent" || rfq.status === "received" || rfq.status === "closed"
              ? [
                  {
                    id: "sent",
                    at: fmt(rfq.updated_at),
                    title: "Sent to suppliers",
                    tone: "info" as const,
                  },
                ]
              : []),
            ...(rfq.status === "closed"
              ? [
                  {
                    id: "closed",
                    at: fmt(rfq.updated_at),
                    title: "Awarded and closed",
                    tone: "success" as const,
                  },
                ]
              : []),
            ...(rfq.status === "cancelled"
              ? [
                  {
                    id: "cancelled",
                    at: fmt(rfq.updated_at),
                    title: "Cancelled",
                    tone: "danger" as const,
                  },
                ]
              : []),
          ]
        : undefined,
    };
  }, [rfq, loading, error, formatCurrency, baseCurrency, columns, convertToPurchaseOrder]);

  return { rfq, loading, error, view };
}
