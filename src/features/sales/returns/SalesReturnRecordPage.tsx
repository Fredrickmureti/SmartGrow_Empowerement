/**
 * SalesReturnRecordPage — object-page route for a Sales Return.
 * Read-only, powered by SalesRecordScaffold. Refund wizard lands at
 * /sales/returns/:id/refund.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { format } from "date-fns";

import { StatusBadge } from "@/design-system";
import { SalesRecordScaffold } from "@/features/sales/record";
import type { LineItemColumn, LineItemRow } from "@/features/sales/record";
import { supabase } from "@/integrations/supabase/client";
import { useCurrency } from "@/hooks/useCurrency";
import type { SalesReturn, SalesReturnItem } from "@/hooks/useSalesReturns";

type Row = SalesReturn & {
  contact?: { name: string; email: string | null; phone: string | null } | null;
  sales_return_items?: SalesReturnItem[];
};

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger" | "accent"> = {
  draft: "neutral",
  approved: "info",
  processed: "success",
  refunded: "success",
  cancelled: "danger",
};

function fmt(d?: string | null) {
  if (!d) return "—";
  try { return format(new Date(d), "PP"); } catch { return d; }
}

export default function SalesReturnRecordPage() {
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
        .from("sales_returns")
        .select("*, contact:contacts(name, email, phone), sales_return_items(*)")
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
    { id: "reason", header: "Return reason", width: "160px", hideOnMobile: true },
    { id: "condition", header: "Condition", width: "110px", hideOnMobile: true },
    { id: "total", header: "Subtotal", width: "120px", numeric: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const items = row?.sales_return_items ?? [];
    return items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((l, i) => ({
        id: l.id ?? String(i),
        cells: [
          { columnId: "description", content: l.description || "—" },
          { columnId: "qty", content: l.quantity },
          { columnId: "unit", content: formatCurrency(l.unit_price ?? 0) },
          { columnId: "reason", content: l.return_reason ?? "—" },
          { columnId: "condition", content: l.condition ?? "—" },
          { columnId: "total", content: formatCurrency(l.line_total ?? 0) },
        ],
      }));
  }, [row, formatCurrency]);

  return (
    <SalesRecordScaffold
      eyebrow="Sales Return"
      listPath="/sales/returns"
      id={id}
      loading={loading}
      error={error}
      notFound={!loading && !isNew && !row}
      newLabel="New sales return"
      title={row?.contact?.name ?? "Customer"}
      docNumber={row?.return_number}
      status={row ? <StatusBadge tone={TONE[row.status] ?? "neutral"}>{row.status}</StatusBadge> : undefined}
      meta={row && (
        <>
          <span>Date {fmt(row.return_date)}</span>
          <span className="tabular-nums">{formatCurrency(row.total ?? 0)} {row.currency}</span>
        </>
      )}
      detailFields={row ? [
        { label: "Customer", value: row.contact?.name },
        { label: "Source invoice", value: row.invoice_id ?? "—" },
        { label: "Return date", value: fmt(row.return_date) },
        { label: "Reason", value: row.reason },
        { label: "Refund method", value: row.refund_method },
        { label: "Credit note", value: row.credit_note_id ?? "—" },
        { label: "Currency", value: row.currency },
      ] : undefined}
      lineColumns={columns}
      lineRows={rows}
      totalsRows={row ? [
        { label: "Subtotal", value: formatCurrency(row.subtotal ?? 0) },
        { label: "Tax", value: formatCurrency(row.tax_amount ?? 0) },
        { label: "Total", value: formatCurrency(row.total ?? 0), emphasized: true },
      ] : undefined}
      totalsFooter={row ? `Currency ${row.currency}` : undefined}
      activity={row ? [
        { id: "created", at: fmt(row.created_at), actor: "System", title: `Return ${row.return_number} created` },
        ...(row.credit_note_id ? [{ id: "credit", at: fmt(row.updated_at), title: "Credit note issued", tone: "info" as const }] : []),
      ] : undefined}
    />
  );
}