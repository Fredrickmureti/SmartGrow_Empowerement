/**
 * rfqView — the one description of an RFQ, shared by the peek and the
 * full record page.
 *
 * Reads the sourcing graph produced by the RFQ RPCs: lines, invitations,
 * versioned quotations (with a per-line comparison matrix) and awards.
 */
import { useMemo } from "react";
import { format } from "date-fns";
import { Award, Clock, MailWarning, Send, Trophy } from "lucide-react";

import type {
  DocumentRecordView,
  LineItemColumn,
  LineItemRow,
} from "@/design-system/records";
import { Section, StatusBadge } from "@/design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import {
  rfqAwardedValue,
  rfqEstimatedValue,
  type RFQQuotation,
  type RFQWithRelations,
  useRFQs,
} from "@/hooks/useRFQs";
import { useRFQRecord } from "./useRFQRecord";
import { BidAttachmentsPanel } from "./BidAttachmentsPanel";


const fmt = (v?: string | null) => {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
};

const label = (s?: string | null) =>
  (s ?? "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const INVITATION_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  pending: "neutral",
  sent: "info",
  viewed: "info",
  responded: "success",
  declined: "danger",
  no_bid: "warning",
  superseded: "neutral",
};

// Delivery is a separate axis from the invitation's commercial state: an
// invitation can be `pending` because the email bounced, not because the
// supplier is slow. Surfacing it is what makes a stuck queue visible.
const DELIVERY_TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  not_sent: "neutral",
  queued: "warning",
  sent: "success",
  failed: "danger",
  bounced: "danger",
};

interface Result {
  rfq: RFQWithRelations | null;
  loading: boolean;
  error: string | null;
  view: DocumentRecordView;
}

/** Only the newest non-withdrawn quotation per supplier competes. */
export function activeQuotations(rfq: RFQWithRelations | null): RFQQuotation[] {
  const bySupplier = new Map<string, RFQQuotation>();
  for (const q of rfq?.quotations ?? []) {
    if (q.state === "withdrawn" || q.state === "superseded") continue;
    if (q.rfq_version !== (rfq?.version ?? q.rfq_version)) continue;
    const prev = bySupplier.get(q.supplier_id);
    if (!prev || q.quotation_version > prev.quotation_version) {
      bySupplier.set(q.supplier_id, q);
    }
  }
  return [...bySupplier.values()].sort((a, b) => a.total - b.total);
}

export function useRFQView(
  id: string | null | undefined,
  formatCurrency: (v: number, currency?: string) => string,
): Result {
  const { record, loading, error } = useRFQRecord(id);
  const { resendInvitation, isResendingInvitation } = useRFQs();
  const { baseCurrency } = useCurrency();
  const rfq = (record as RFQWithRelations | undefined) ?? null;
  const currency = rfq?.currency || baseCurrency;

  const columns = useMemo<LineItemColumn[]>(
    () => [
      { id: "description", header: "Description", priority: 1, minWidth: 200 },
      { id: "qty", header: "Qty", numeric: true, priority: 1, minWidth: 70, compactLabel: "Qty" },
      { id: "target", header: "Target price", numeric: true, priority: 2, minWidth: 120 },
      { id: "best", header: "Best quote", numeric: true, priority: 2, minWidth: 120 },
      { id: "alternates", header: "Alternates", priority: 3, minWidth: 160 },
      { id: "awarded", header: "Awarded", priority: 3, minWidth: 140 },
    ],
    [],
  );

  const view = useMemo<DocumentRecordView>(() => {
    const items = (rfq?.items ?? []).slice().sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
    );
    const invitations = rfq?.invitations ?? [];
    const quotes = activeQuotations(rfq);
    const awards = rfq?.awards ?? [];
    const awardGated = Boolean(rfq?.award_approval_request_id);

    const supplierName = (supplierId: string) =>
      invitations.find((i) => i.supplier_id === supplierId)?.supplier?.name ??
      quotes.find((q) => q.supplier_id === supplierId)?.supplier?.name ??
      "Unknown supplier";

    /** Cheapest unit price offered per RFQ line, across live quotations. */
    const bestByLine = new Map<string, { price: number; supplierId: string }>();
    for (const q of quotes) {
      for (const li of q.items ?? []) {
        const cur = bestByLine.get(li.rfq_item_id);
        if (!cur || li.unit_price < cur.price) {
          bestByLine.set(li.rfq_item_id, { price: li.unit_price, supplierId: q.supplier_id });
        }
      }
    }

    /**
     * Suppliers who offered a substitute product instead of the requested
     * one. Buyers must see this before comparing on price alone — an
     * alternate is not a like-for-like bid.
     */
    const alternatesByLine = new Map<string, string[]>();
    for (const q of quotes) {
      for (const li of q.items ?? []) {
        if (!li.is_alternate) continue;
        const cur = alternatesByLine.get(li.rfq_item_id) ?? [];
        cur.push(q.supplier?.name ?? supplierName(q.supplier_id));
        alternatesByLine.set(li.rfq_item_id, cur);
      }
    }

    /** Awarded quantity + winner per line (split awards accumulate). */
    const awardedByLine = new Map<string, { qty: number; suppliers: Set<string> }>();
    for (const a of awards) {
      for (const ai of a.items ?? []) {
        const cur = awardedByLine.get(ai.rfq_item_id) ?? { qty: 0, suppliers: new Set<string>() };
        cur.qty += ai.awarded_quantity ?? 0;
        cur.suppliers.add(a.supplier_id);
        awardedByLine.set(ai.rfq_item_id, cur);
      }
    }

    const rows: LineItemRow[] = items.map((line, idx) => {
      const best = line.id ? bestByLine.get(line.id) : undefined;
      const awarded = line.id ? awardedByLine.get(line.id) : undefined;
      return {
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "qty", content: line.quantity },
          {
            columnId: "target",
            content:
              line.target_price != null ? formatCurrency(line.target_price, currency) : "—",
          },
          {
            columnId: "best",
            content: best
              ? `${formatCurrency(best.price, currency)} · ${supplierName(best.supplierId)}`
              : "—",
          },
          {
            columnId: "alternates",
            content: (line.id ? alternatesByLine.get(line.id) : undefined)?.join(", ") ?? "—",
          },
          {
            columnId: "awarded",
            content: awarded
              ? `${awarded.qty} → ${[...awarded.suppliers].map(supplierName).join(", ")}`
              : "—",
          },
        ],
      };
    });

    const estimatedTotal = rfqEstimatedValue({ items });
    const awardedTotal = rfqAwardedValue({ awards });
    const responded = invitations.filter((i) => i.invitation_state === "responded").length;

    return {
      kind: "rfq",
      documentId: rfq?.id,
      eyebrow: `Request for Quotation${rfq && rfq.version > 1 ? ` · rev ${rfq.version}` : ""}`,
      listPath: "/purchases/rfqs",
      title: rfq?.rfq_number ?? "RFQ",
      docNumber: rfq
        ? `${invitations.length} invited · ${quotes.length} quoted · ${items.length} lines`
        : undefined,
      status: rfq?.status,
      loading,
      error,
      notFound: !loading && !error && !rfq,
      meta: rfq ? (
        <>
          <span>Created {fmt(rfq.created_at)}</span>
          {rfq.deadline && <span>Deadline {fmt(rfq.deadline)}</span>}
          {rfq.required_by_date && <span>Need by {fmt(rfq.required_by_date)}</span>}
          <span className="tabular-nums">
            {awardedTotal > 0
              ? `Awarded ${formatCurrency(awardedTotal, currency)}`
              : `Est. ${formatCurrency(estimatedTotal, currency)}`}
          </span>
        </>
      ) : undefined,
      totalsRows: rfq
        ? [
            { label: "Lines", value: String(items.length) },
            { label: "Invited", value: String(invitations.length) },
            { label: "Responded", value: `${responded} / ${invitations.length}` },
            {
              label: awardedTotal > 0 ? "Awarded value" : "Estimated value",
              value: formatCurrency(awardedTotal > 0 ? awardedTotal : estimatedTotal, currency),
              emphasized: true,
            },
          ]
        : undefined,
      totalsFooter: rfq ? `Currency ${currency}` : undefined,
      detailFields: rfq
        ? [
            { label: "RFQ #", value: rfq.rfq_number },
            { label: "Revision", value: String(rfq.version) },
            { label: "Status", value: label(rfq.status) },
            { label: "Created", value: fmt(rfq.created_at) },
            { label: "Quote deadline", value: fmt(rfq.deadline) },
            { label: "Required by", value: fmt(rfq.required_by_date) },
            { label: "Approved", value: fmt(rfq.approved_at) },
            { label: "Released", value: fmt(rfq.released_at) },
            { label: "Awarded", value: fmt(rfq.awarded_at) },
          ]
        : undefined,
      lineColumns: columns,
      lineRows: rows,
      lineEmpty: "No lines on this RFQ.",
      extraSections: rfq ? (
        <>
          <Section title="Invited suppliers">
            {invitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No suppliers were invited.</p>
            ) : (
              <div className="space-y-2">
                {invitations.map((inv) => {
                  const quote = quotes.find((q) => q.supplier_id === inv.supplier_id);
                  return (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between rounded-lg border p-3"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
                          {inv.supplier?.name?.charAt(0) ?? "?"}
                        </div>
                        <div>
                          <p className="text-sm font-medium">
                            {inv.supplier?.name ?? "Unknown supplier"}
                          </p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2">
                            <StatusBadge
                              tone={INVITATION_TONE[inv.invitation_state] ?? "neutral"}
                            >
                              {label(inv.invitation_state)}
                            </StatusBadge>
                            <StatusBadge tone={DELIVERY_TONE[inv.delivery_state] ?? "neutral"}>
                              {inv.delivery_state === "sent" && inv.sent_at
                                ? `Sent ${fmt(inv.sent_at)}`
                                : label(inv.delivery_state)}
                            </StatusBadge>
                            {(inv.delivery_attempts ?? 0) > 1 && (
                              <Badge variant="outline" className="text-xs">
                                {inv.delivery_attempts} attempts
                              </Badge>
                            )}
                            {inv.delivery_error && (
                              <span className="inline-flex items-center gap-1 text-xs text-destructive">
                                <MailWarning className="h-3 w-3" />
                                {inv.delivery_error}
                              </span>
                            )}
                            {quote && (
                              <Badge variant="outline" className="text-xs">
                                v{quote.quotation_version} ·{" "}
                                {formatCurrency(quote.total, quote.currency)}
                              </Badge>
                            )}
                            {quote?.is_late && (
                              <Badge variant="destructive" className="text-xs">
                                <Clock className="mr-1 h-3 w-3" />
                                Late
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      {(inv.delivery_state === "failed" ||
                        inv.delivery_state === "bounced" ||
                        inv.delivery_state === "queued") && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isResendingInvitation}
                          onClick={() => resendInvitation(inv.id)}
                        >
                          <Send className="mr-1.5 h-3.5 w-3.5" />
                          Resend
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          <Section title="Quotation comparison">
            {quotes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No quotations received yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3">Supplier</th>
                      <th className="py-2 pr-3 text-right">Total</th>
                      <th className="py-2 pr-3 text-right">Lead time</th>
                      <th className="py-2 pr-3">Incoterms</th>
                      <th className="py-2 pr-3">Payment terms</th>
                      <th className="py-2 pr-3">Valid until</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quotes.map((q, i) => (
                      <tr key={q.id} className="border-b last:border-0">
                        <td className="py-2 pr-3">
                          <span className="flex items-center gap-2">
                            {i === 0 && <Trophy className="h-3.5 w-3.5 text-emerald-600" />}
                            {q.supplier?.name ?? "—"}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right font-medium tabular-nums">
                          {formatCurrency(q.total, q.currency)}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {q.lead_time_days != null ? `${q.lead_time_days} d` : "—"}
                        </td>
                        <td className="py-2 pr-3">{q.incoterms ?? "—"}</td>
                        <td className="py-2 pr-3">{q.payment_terms ?? "—"}</td>
                        <td className="py-2 pr-3">{fmt(q.valid_until)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {quotes.length > 0 && (
            <Section title="Bid documents">
              {/*
                Evidence submitted with each live bid. Read-only for the buyer:
                attachments belong to the supplier's quotation version and are
                immutable once that version is superseded.
              */}
              <div className="space-y-5">
                {quotes.map((q) => (
                  <div key={q.id}>
                    <p className="text-sm font-medium">
                      {q.supplier?.name ?? "—"}{" "}
                      <span className="text-muted-foreground font-normal">
                        · quote v{q.quotation_version}
                      </span>
                    </p>
                    <BidAttachmentsPanel
                      className="mt-2"
                      rfqId={q.rfq_id}
                      quotationId={q.id}
                      canEdit={false}
                      emptyLabel="This supplier attached no supporting documents."
                    />
                  </div>
                ))}
              </div>
            </Section>
          )}


          {awards.length > 0 && (
            <Section title="Awards">
              {awardGated && (
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  <Clock className="h-4 w-4 shrink-0" />
                  <span>
                    This award is awaiting approval. Purchase orders cannot be raised until the
                    decision is recorded in Approvals.
                  </span>
                </div>
              )}
              <div className="space-y-2">
                {awards.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center justify-between rounded-lg border p-3 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <Award className="h-4 w-4 text-emerald-600" />
                      <span className="font-medium">{a.supplier?.name ?? "—"}</span>
                      <span className="text-muted-foreground">
                        {(a.items ?? []).length} line(s)
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums font-medium">
                        {formatCurrency(a.awarded_value, a.currency)}
                      </span>
                      <StatusBadge tone={a.purchase_order_id ? "success" : "warning"}>
                        {a.purchase_order_id ? "Converted to PO" : "Awaiting PO"}
                      </StatusBadge>
                    </div>
                  </div>
                ))}
              </div>
              {rfq.award_justification && (
                <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
                  {rfq.award_justification}
                </p>
              )}
            </Section>
          )}

          {rfq.notes && (
            <Section title="Notes">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{rfq.notes}</p>
            </Section>
          )}
        </>
      ) : undefined,
      activity: rfq
        ? [
            {
              id: "created",
              at: fmt(rfq.created_at),
              actor: "System",
              title: `RFQ ${rfq.rfq_number} created`,
            },
            ...(rfq.approved_at
              ? [
                  {
                    id: "approved",
                    at: fmt(rfq.approved_at),
                    title: "Approved for sourcing",
                    tone: "info" as const,
                  },
                ]
              : []),
            ...(rfq.released_at
              ? [
                  {
                    id: "released",
                    at: fmt(rfq.released_at),
                    title: `Released to ${invitations.length} supplier(s)`,
                    tone: "info" as const,
                  },
                ]
              : []),
            ...(rfq.awarded_at
              ? [
                  {
                    id: "awarded",
                    at: fmt(rfq.awarded_at),
                    title: `Awarded ${formatCurrency(awardedTotal, currency)}`,
                    tone: "success" as const,
                  },
                ]
              : []),
            ...(rfq.converted_at
              ? [
                  {
                    id: "converted",
                    at: fmt(rfq.converted_at),
                    title: "Converted to purchase order(s)",
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
  }, [
    rfq,
    loading,
    error,
    formatCurrency,
    currency,
    columns,
    resendInvitation,
    isResendingInvitation,
  ]);

  return { rfq, loading, error, view };
}
