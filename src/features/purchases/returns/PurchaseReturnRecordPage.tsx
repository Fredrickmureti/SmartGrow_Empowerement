/**
 * PurchaseReturnRecordPage — `/purchases/returns/:id`.
 *
 * Object-page route mirroring BillRecordPage / SalesReturnRecordPage.
 * Read-only detail; edit routes via `/edit` when the return is still pending.
 */
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";
import { ArrowLeft, Pencil } from "lucide-react";

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
  LineItemsGrid,
  type LineItemColumn,
  type LineItemRow,
} from "@/design-system";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";
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

export default function PurchaseReturnRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const { record, loading, error } = usePurchaseReturnRecord(id);

  const columns = useMemo<LineItemColumn[]>(
    () => [
      { id: "description", header: "Description", width: "minmax(0,1fr)" },
      { id: "qty", header: "Qty", width: "80px", numeric: true },
      { id: "unit", header: "Unit price", width: "120px", numeric: true },
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

  if (loading) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Purchase Return" title="Loading…" />}>
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (error || !record) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Purchase Return" title="Purchase Return" />}>
        <Section>
          <ErrorState
            title="Unable to load purchase return"
            description={error ?? "Not found."}
            onRetry={() => navigate("/purchases/returns")}
          />
        </Section>
      </RecordShell>
    );
  }

  const tone = TONE[record.status] ?? "neutral";
  const isPending = record.status === "pending";

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow="Purchase Return"
          title={record.vendor?.name ?? "Vendor"}
          docNumber={record.return_number}
          status={<StatusBadge tone={tone}>{label(record.status)}</StatusBadge>}
          meta={
            <>
              <span>Returned {fmtDate(record.return_date)}</span>
              <span className="tabular-nums">
                {formatCurrency(record.total ?? 0)} {record.currency ?? ""}
              </span>
              {record.reason && <span>Reason: {record.reason}</span>}
            </>
          }
          actions={
            <ActionBar>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/purchases/returns")}
              >
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button
                size="sm"
                variant={isPending ? "default" : "outline"}
                disabled={!isPending}
                title={isPending ? undefined : "Only pending returns are editable"}
                onClick={() => navigate(`/purchases/returns/${record.id}/edit`)}
              >
                <Pencil className="mr-2 h-4 w-4" /> Edit
              </Button>
            </ActionBar>
          }
        />
      }
      aside={
        <SummaryPanel>
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
          <DocumentActivityPanel
            entries={[
              {
                id: "created",
                at: fmtDate(record.created_at),
                actor: "System",
                title: `Return ${record.return_number} created`,
              },
            ]}
          />
        </SummaryPanel>
      }
      footer={
        <FooterActionBar
          trailing={
            <Button
              variant="outline"
              onClick={() => navigate("/purchases/returns")}
            >
              Close
            </Button>
          }
        />
      }
    >
      <Section title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Vendor</dt>
            <dd className="mt-0.5">{record.vendor?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Return date</dt>
            <dd className="mt-0.5">{fmtDate(record.return_date)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Reason</dt>
            <dd className="mt-0.5">{record.reason || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Currency</dt>
            <dd className="mt-0.5">{record.currency ?? "—"}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Line items">
        <LineItemsGrid columns={columns} rows={rows} readOnly />
      </Section>

      {record.notes && (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-sm">{record.notes}</p>
        </Section>
      )}

      <DocumentVersionsSection documentType="purchase_return" documentId={record.id} />
    </RecordShell>
  );
}
