/**
 * DeliveryNoteRecordPage — object-page route for a Delivery Note.
 * Read-only, powered by SalesRecordScaffold.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { format } from "date-fns";

import { StatusBadge } from "@/design-system";
import { SalesRecordScaffold } from "@/features/sales/record";
import type { LineItemColumn, LineItemRow } from "@/features/sales/record";
import { supabase } from "@/integrations/supabase/client";
import type { DeliveryNote, DeliveryNoteItem } from "@/hooks/useDeliveryNotes";

type Row = DeliveryNote & {
  contact?: { name: string; email: string | null; phone: string | null } | null;
  delivery_note_items?: DeliveryNoteItem[];
};

const TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger" | "accent"> = {
  draft: "neutral",
  ready: "info",
  in_transit: "accent",
  delivered: "success",
  cancelled: "danger",
};

function fmt(d?: string | null) {
  if (!d) return "—";
  try { return format(new Date(d), "PP"); } catch { return d; }
}

export default function DeliveryNoteRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
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
        .from("delivery_notes")
        .select("*, contact:contacts(name, email, phone), delivery_note_items(*)")
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
    { id: "ordered", header: "Ordered", width: "100px", numeric: true },
    { id: "delivered", header: "Delivered", width: "100px", numeric: true },
    { id: "outstanding", header: "Outstanding", width: "110px", numeric: true, hideOnMobile: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const items = row?.delivery_note_items ?? [];
    return items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((l, i) => ({
        id: l.id ?? String(i),
        cells: [
          { columnId: "description", content: l.description || "—" },
          { columnId: "ordered", content: l.quantity_ordered },
          { columnId: "delivered", content: l.quantity_delivered },
          { columnId: "outstanding", content: Math.max(0, (l.quantity_ordered ?? 0) - (l.quantity_delivered ?? 0)) },
        ],
      }));
  }, [row]);

  return (
    <SalesRecordScaffold
      eyebrow="Delivery Note"
      listPath="/sales/delivery-notes"
      id={id}
      loading={loading}
      error={error}
      notFound={!loading && !isNew && !row}
      newLabel="New delivery note"
      title={row?.contact?.name ?? "Customer"}
      docNumber={row?.delivery_number}
      status={row ? <StatusBadge tone={TONE[row.status] ?? "neutral"}>{row.status}</StatusBadge> : undefined}
      meta={row && (
        <>
          <span>Date {fmt(row.delivery_date)}</span>
          {row.delivered_at && <span>Delivered {fmt(row.delivered_at)}</span>}
        </>
      )}
      detailFields={row ? [
        { label: "Customer", value: row.contact?.name },
        { label: "Email", value: row.contact?.email },
        { label: "Phone", value: row.contact?.phone },
        { label: "Delivery date", value: fmt(row.delivery_date) },
        { label: "Driver", value: row.driver_name },
        { label: "Vehicle #", value: row.vehicle_number },
        { label: "Shipping address", value: row.shipping_address },
        { label: "Received by", value: row.received_by },
        { label: "Source SO", value: row.sales_order_id },
      ] : undefined}
      lineColumns={columns}
      lineRows={rows}
      activity={row ? [
        { id: "created", at: fmt(row.created_at), actor: "System", title: `Delivery ${row.delivery_number} created` },
        ...(row.delivered_at ? [{ id: "delivered", at: fmt(row.delivered_at), title: "Delivered", tone: "success" as const }] : []),
      ] : undefined}
    />
  );
}