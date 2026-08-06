/**
 * CreditNoteRecordPage — object-page route for a Credit Note.
 * Read-only, powered by RecordScaffold. The "apply to invoice"
 * wizard lands separately at /sales/credit-notes/:id/apply.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { format } from "date-fns";

import { StatusBadge } from "@/design-system";
import { RecordScaffold } from "@/design-system/records";
import type { LineItemColumn, LineItemRow } from "@/design-system/records";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import type { CreditNote, CreditNoteItem } from "@/hooks/useCreditNotes";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

type Row = CreditNote & {
  contact?: { name: string; email: string | null; phone: string | null } | null;
  credit_note_items?: CreditNoteItem[];
};

function fmt(d?: string | null) {
  if (!d) return "—";
  try { return format(new Date(d), "PP"); } catch { return d; }
}

export default function CreditNoteRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { formatCurrency } = useCurrency();
  const [row, setRow] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isNew = id === "new";

  useEffect(() => {
    if (isNew) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      const { data, error: err } = await supabase
        .from("credit_notes")
        .select("*, contact:contacts(name, email, phone), credit_note_items(*)")
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (err) setError(err.message);
      else setRow((data as unknown as Row) ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, isNew]);

  const columns = useMemo<LineItemColumn[]>(() => [
    { id: "description", header: "Description", width: "minmax(0,1fr)" },
    { id: "qty", header: "Qty", width: "80px", numeric: true },
    { id: "unit", header: "Unit price", width: "120px", numeric: true },
    { id: "tax", header: "Tax %", width: "80px", numeric: true, hideOnMobile: true },
    { id: "total", header: "Subtotal", width: "120px", numeric: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const items = row?.credit_note_items ?? [];
    return items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((l, i) => ({
        id: l.id ?? String(i),
        cells: [
          { columnId: "description", content: l.description || "—" },
          { columnId: "qty", content: l.quantity },
          { columnId: "unit", content: formatCurrency(l.unit_price ?? 0) },
          { columnId: "tax", content: l.tax_rate ?? 0 },
          { columnId: "total", content: formatCurrency(l.line_total ?? 0) },
        ],
      }));
  }, [row, formatCurrency]);

  const remaining = row ? Math.max(0, (row.total ?? 0) - (row.amount_applied ?? 0)) : 0;
  const isFullyApplied = row && remaining <= 0;

  return (
    <RecordScaffold
      eyebrow="Credit Note"
      listPath="/sales/credit-notes"
      id={id}
      loading={loading}
      error={error}
      notFound={!loading && !isNew && !row}
      newLabel="New credit note"
      title={row?.contact?.name ?? "Customer"}
      docNumber={row?.credit_note_number}
      kind="credit_note"
      statusSlot={row ? (
        <StatusBadge tone={isFullyApplied ? "success" : "warning"}>
          {isFullyApplied ? "Fully applied" : "Open"}
        </StatusBadge>
      ) : undefined}
      meta={row && (
        <>
          <span>Issued {fmt(row.issue_date)}</span>
          <span className="tabular-nums">{formatCurrency(row.total ?? 0)} {row.currency}</span>
        </>
      )}
      detailFields={row ? [
        { label: "Customer", value: row.contact?.name },
        { label: "Reason", value: row.reason },
        { label: "Source invoice", value: row.invoice_id ?? "—" },
        { label: "Issue date", value: fmt(row.issue_date) },
        { label: "Currency", value: row.currency },
        { label: "Notes", value: row.notes },
      ] : undefined}
      lineColumns={columns}
      lineRows={rows}
      totalsRows={row ? [
        { label: "Subtotal", value: formatCurrency(row.subtotal ?? 0) },
        { label: "Tax", value: formatCurrency(row.tax_amount ?? 0) },
        { label: "Total", value: formatCurrency(row.total ?? 0), emphasized: true },
        { label: "Applied", value: formatCurrency(row.amount_applied ?? 0), muted: true },
        { label: "Remaining", value: formatCurrency(remaining), emphasized: true },
      ] : undefined}
      totalsFooter={row ? `Currency ${row.currency}` : undefined}
      activity={row ? [
        { id: "created", at: fmt(row.created_at), actor: "System", title: `Credit note ${row.credit_note_number} created` },
        ...(isFullyApplied ? [{ id: "applied", at: fmt(row.updated_at), title: "Fully applied", tone: "success" as const }] : []),
      ] : undefined}
      extraSections={row ? <DocumentVersionsSection documentType="credit_note" documentId={row.id} /> : undefined}
    />
  );
}