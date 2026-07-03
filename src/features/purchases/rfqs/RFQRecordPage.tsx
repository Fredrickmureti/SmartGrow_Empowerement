/**
 * RFQRecordPage — `/purchases/rfqs/:id`.
 *
 * Object-page route mirroring PurchaseOrderRecordPage /
 * VendorCreditNoteRecordPage. Read-only body + right-rail actions
 * (Send / Mark received / Award & convert to PO / Cancel).
 */
import { useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";
import {
  ArrowLeft,
  ArrowRightLeft,
  Award,
  Ban,
  FileText,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";

import {
  ActionBar,
  ErrorState,
  FooterActionBar,
  LoadingState,
  RecordHeader,
  RecordShell,
  Section,
  StatusBadge,
  SummaryPanel,
  DocumentActivityPanel,
  DocumentTotalsPanel,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import { useRFQs } from "@/hooks/useRFQs";
import { useRFQRecord } from "./useRFQRecord";
import { RFQRecordBody } from "./RFQRecordBody";

const TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  draft: "neutral",
  sent: "info",
  received: "warning",
  closed: "success",
  cancelled: "danger",
};

const fmtDate = (v?: string | null) => {
  if (!v) return "—";
  try {
    return format(new Date(v), "PP");
  } catch {
    return v;
  }
};
const label = (s: string) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default function RFQRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency, baseCurrency } = useCurrency();
  const { record, loading, error } = useRFQRecord(id);
  const { updateStatus, convertToPurchaseOrder, deleteRFQ } = useRFQs();

  if (loading) {
    return (
      <RecordShell header={<RecordHeader eyebrow="RFQ" title="Loading…" />}>
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (error || !record) {
    return (
      <RecordShell header={<RecordHeader eyebrow="RFQ" title="RFQ" />}>
        <Section>
          <ErrorState
            title="Unable to load RFQ"
            description={error ?? "Not found."}
            onRetry={() => navigate("/purchases/rfqs")}
          />
        </Section>
      </RecordShell>
    );
  }

  const tone = TONE[record.status] ?? "neutral";
  const isDraft = record.status === "draft";
  const vendors = ((record as any).vendors ?? []) as any[];
  const items = ((record as any).items ?? []) as any[];
  const estimatedTotal = items.reduce(
    (s, i) => s + (i.target_price ?? 0) * (i.quantity ?? 0),
    0,
  );

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow="Request for Quotation"
          title={record.rfq_number}
          docNumber={`${vendors.length} suppliers · ${items.length} items`}
          status={<StatusBadge tone={tone}>{label(record.status)}</StatusBadge>}
          meta={
            <>
              <span>Created {fmtDate(record.created_at)}</span>
              {record.deadline && <span>Deadline {fmtDate(record.deadline)}</span>}
              {estimatedTotal > 0 && (
                <span className="tabular-nums">
                  Est. {formatCurrency(estimatedTotal, baseCurrency)}
                </span>
              )}
            </>
          }
          actions={
            <ActionBar>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/purchases/rfqs")}
              >
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              {isDraft && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/purchases/rfqs/${record.id}/edit`)}
                >
                  <Pencil className="mr-2 h-4 w-4" /> Edit
                </Button>
              )}
              {isDraft && (
                <Button
                  size="sm"
                  onClick={() =>
                    updateStatus({ id: record.id, status: "sent" })
                  }
                >
                  <Send className="mr-2 h-4 w-4" /> Mark sent
                </Button>
              )}
              {record.status === "sent" && (
                <Button
                  size="sm"
                  onClick={() =>
                    updateStatus({ id: record.id, status: "received" })
                  }
                >
                  <FileText className="mr-2 h-4 w-4" /> Mark received
                </Button>
              )}
            </ActionBar>
          }
        />
      }
      aside={
        <SummaryPanel>
          <DocumentTotalsPanel
            rows={[
              {
                label: "Items",
                value: String(items.length),
              },
              {
                label: "Suppliers",
                value: String(vendors.length),
              },
              {
                label: "Estimated value",
                value: formatCurrency(estimatedTotal, baseCurrency),
                emphasized: true,
              },
            ]}
            footer={`Currency ${baseCurrency}`}
          />
          {record.status === "received" && (
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
                            rfqId: record.id,
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
          )}
          <DocumentActivityPanel
            entries={[
              {
                id: "created",
                at: fmtDate(record.created_at),
                actor: "System",
                title: `RFQ ${record.rfq_number} created`,
              },
              ...(record.status === "sent" || record.status === "received" || record.status === "closed"
                ? [
                    {
                      id: "sent",
                      at: fmtDate(record.updated_at),
                      title: "Sent to suppliers",
                      tone: "info" as const,
                    },
                  ]
                : []),
              ...(record.status === "closed"
                ? [
                    {
                      id: "closed",
                      at: fmtDate(record.updated_at),
                      title: "Awarded and closed",
                      tone: "success" as const,
                    },
                  ]
                : []),
              ...(record.status === "cancelled"
                ? [
                    {
                      id: "cancelled",
                      at: fmtDate(record.updated_at),
                      title: "Cancelled",
                      tone: "danger" as const,
                    },
                  ]
                : []),
            ]}
          />
        </SummaryPanel>
      }
      footer={
        <FooterActionBar
          leading={
            isDraft ? (
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={() => {
                  if (confirm(`Delete RFQ ${record.rfq_number}?`)) {
                    deleteRFQ(record.id);
                    navigate("/purchases/rfqs");
                  }
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </Button>
            ) : null
          }
          trailing={
            <>
              {["draft", "sent", "received"].includes(record.status) && (
                <Button
                  variant="outline"
                  onClick={() =>
                    updateStatus({ id: record.id, status: "cancelled" })
                  }
                >
                  <Ban className="mr-2 h-4 w-4" /> Cancel RFQ
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => navigate("/purchases/rfqs")}
              >
                Close
              </Button>
            </>
          }
        />
      }
    >
      <RFQRecordBody record={record} />
    </RecordShell>
  );
}