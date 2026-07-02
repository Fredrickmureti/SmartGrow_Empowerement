/**
 * VendorCreditNoteRecordPage — `/purchases/credit-notes/:id`.
 *
 * Object-page route mirroring BillRecordPage / SalesCreditNoteRecordPage.
 * Read-only detail; edit routes via `/edit` when the note is still draft.
 */
import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
import { Button } from "@/components/ui/button";
import { useCurrency } from "@/hooks/useCurrency";
import { useVendorCreditNoteRecord } from "./useVendorCreditNoteRecord";

const TONE: Record<
  string,
  "neutral" | "info" | "success" | "warning" | "danger" | "accent"
> = {
  draft: "neutral",
  confirmed: "info",
  applied: "success",
  void: "danger",
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

export default function VendorCreditNoteRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { formatCurrency } = useCurrency();
  const { record, loading, error } = useVendorCreditNoteRecord(id);

  const columns = useMemo<LineItemColumn[]>(
    () => [
      { id: "description", header: "Description", width: "minmax(0,1fr)" },
      { id: "qty", header: "Qty", width: "80px", numeric: true },
      { id: "unit", header: "Unit price", width: "120px", numeric: true },
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

  if (loading) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Vendor Credit Note" title="Loading…" />}>
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  if (error || !record) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Vendor Credit Note" title="Credit Note" />}>
        <Section>
          <ErrorState
            title="Unable to load credit note"
            description={error ?? "Not found."}
            onRetry={() => navigate("/purchases/credit-notes")}
          />
        </Section>
      </RecordShell>
    );
  }

  const tone = TONE[record.status] ?? "neutral";
  const remaining = Math.max(
    0,
    (record.total ?? 0) - ((record as any).amount_applied ?? 0),
  );
  const isDraft = record.status === "draft";

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow="Vendor Credit Note"
          title={record.vendor?.name ?? "Vendor"}
          docNumber={record.credit_note_number}
          status={<StatusBadge tone={tone}>{label(record.status)}</StatusBadge>}
          meta={
            <>
              <span>Dated {fmtDate(record.credit_date)}</span>
              <span className="tabular-nums">
                {formatCurrency(record.total ?? 0)} {record.currency}
              </span>
              {record.bill?.bill_number && (
                <span>
                  Bill{" "}
                  <Link className="underline" to={`/purchases/bills`}>
                    {record.bill.bill_number}
                  </Link>
                </span>
              )}
            </>
          }
          actions={
            <ActionBar>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/purchases/credit-notes")}
              >
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button
                size="sm"
                variant={isDraft ? "default" : "outline"}
                disabled={!isDraft}
                title={isDraft ? undefined : "Only draft credit notes are editable"}
                onClick={() =>
                  navigate(`/purchases/credit-notes/${record.id}/edit`)
                }
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
              { label: "Subtotal", value: formatCurrency(record.subtotal ?? 0) },
              { label: "Tax", value: formatCurrency(record.tax_amount ?? 0) },
              {
                label: "Total",
                value: formatCurrency(record.total ?? 0),
                emphasized: true,
              },
              {
                label: "Applied",
                value: formatCurrency((record as any).amount_applied ?? 0),
                muted: true,
              },
              {
                label: "Remaining",
                value: formatCurrency(remaining),
                emphasized: true,
              },
            ]}
            footer={`Currency ${record.currency}`}
          />
          <DocumentActivityPanel
            entries={[
              {
                id: "created",
                at: fmtDate(record.created_at),
                actor: "System",
                title: `Credit note ${record.credit_note_number} created`,
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
              onClick={() => navigate("/purchases/credit-notes")}
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
            <dt className="text-xs font-medium text-muted-foreground">Credit date</dt>
            <dd className="mt-0.5">{fmtDate(record.credit_date)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Linked bill</dt>
            <dd className="mt-0.5">{record.bill?.bill_number ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Currency</dt>
            <dd className="mt-0.5">{record.currency}</dd>
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
    </RecordShell>
  );
}
