/**
 * VendorCreditNotePeekSheet — standard peek surface for one vendor
 * credit note. Mirrors the Sales `CreditNotePeekSheet` so the entire
 * ERP presents credit notes the same way. Apply-to-bill and refund
 * actions stay on the list row menu.
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
  creditNoteId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function VendorCreditNotePeekSheet({ creditNoteId, onOpenChange }: Props) {
  const { record, loading, error } = useVendorCreditNoteRecord(creditNoteId);
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

  const remaining = record
    ? Math.max(0, (record.total ?? 0) - (record.amount_applied ?? 0))
    : 0;

  return (
    <DocumentPeekShell
      open={!!creditNoteId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load credit note"
      extraHeaderActions={
        record && record.status === "draft" ? (
          <Button asChild size="sm" variant="outline">
            <Link
              to={`/purchases/credit-notes/${record.id}/edit`}
              onClick={() => onOpenChange(false)}
            >
              <Pencil className="mr-1.5 h-4 w-4" /> Edit
            </Link>
          </Button>
        ) : undefined
      }
      title={
        loading
          ? "Loading credit note…"
          : record
            ? `Credit Note ${record.credit_note_number}`
            : "Credit Note"
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
                  Credit date
                </dt>
                <dd className="mt-0.5">{fmt(record.credit_date)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Linked bill
                </dt>
                <dd className="mt-0.5">
                  {record.bill?.bill_number ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Currency
                </dt>
                <dd className="mt-0.5">{record.currency}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Total credit
                </dt>
                <dd className="mt-0.5 tabular-nums">
                  {formatCurrency(record.total ?? 0)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Remaining
                </dt>
                <dd className="mt-0.5 tabular-nums">
                  {formatCurrency(remaining)}
                </dd>
              </div>
            </dl>
          </Section>
          <Section title="Totals">
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
                  value: formatCurrency(record.amount_applied ?? 0),
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
                  title: `Credit note ${record.credit_note_number} created`,
                },
              ]}
            />
          </Section>
        </div>
      )}
    </DocumentPeekShell>
  );
}

export default VendorCreditNotePeekSheet;
