/**
 * DeliveryNoteRecordPage — object-page route for a Delivery Note.
 * Read-only, powered by RecordScaffold.
 */

import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { format } from "date-fns";

import { StatusBadge } from "@/design-system";
import { RecordScaffold } from "@/design-system/records";
import type { LineItemColumn, LineItemRow } from "@/design-system/records";
import type { DeliveryNote, DeliveryNoteItem } from "@/hooks/useDeliveryNotes";
import { useDeliveryNoteRecord } from "./useDeliveryNoteRecord";
import { useDeliveryNoteLineBalances } from "./useDeliveryNoteLineBalances";
import { resolveRecipientName } from "@/lib/looksLikeUUID";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

type Row = DeliveryNote & {
  contact?: { name: string; email: string | null; phone: string | null } | null;
  received_by_contact?: { name: string | null } | null;
  items?: DeliveryNoteItem[];
};

function fmt(d?: string | null) {
  if (!d) return "—";
  try { return format(new Date(d), "PP"); } catch { return d; }
}

export default function DeliveryNoteRecordPage() {
  const { id = "" } = useParams<{ id: string }>();
  const isNew = id === "new";
  // Single reader for the delivery note record — shared with the peek sheet
  // so the two surfaces cannot drift (and so the contacts embed is
  // disambiguated in exactly one place).
  const { record, loading, error } = useDeliveryNoteRecord(isNew ? null : id);
  const row = record as Row | null;
  const notFound = !loading && !isNew && !row;
  // Quantities come from the canonical ledger view, never re-derived here:
  // it zeroes quantities before goods-issue and nets completed return DNs.
  const { data: balances } = useDeliveryNoteLineBalances(isNew ? null : id);
  const balanceByItem = useMemo(
    () => new Map((balances ?? []).map((b) => [b.delivery_note_item_id, b])),
    [balances],
  );

  const columns = useMemo<LineItemColumn[]>(() => [
    { id: "description", header: "Description", width: "minmax(0,1fr)" },
    { id: "ordered", header: "Ordered", width: "100px", numeric: true },
    { id: "delivered", header: "Delivered", width: "100px", numeric: true },
    { id: "returned", header: "Returned", width: "100px", numeric: true, hideOnMobile: true },
    { id: "outstanding", header: "Outstanding", width: "110px", numeric: true, hideOnMobile: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const items = row?.items ?? [];
    return items
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((l, i) => {
        const b = l.id ? balanceByItem.get(l.id) : undefined;
        return {
          id: l.id ?? String(i),
          cells: [
            { columnId: "description", content: l.description || "—" },
            { columnId: "ordered", content: b?.quantity_ordered ?? l.quantity_ordered },
            { columnId: "delivered", content: b?.quantity_delivered ?? 0 },
            { columnId: "returned", content: b?.quantity_returned ?? 0 },
            { columnId: "outstanding", content: b?.quantity_outstanding ?? 0 },
          ],
        };
      });
  }, [row, balanceByItem]);

  return (
    <RecordScaffold
      eyebrow="Delivery Note"
      listPath="/sales/delivery-notes"
      id={id}
      loading={loading}
      error={notFound ? null : error}
      notFound={notFound}
      newLabel="New delivery note"
      title={row?.contact?.name ?? "Customer"}
      docNumber={row?.delivery_number}
      kind="delivery_note"
      status={row?.status}
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
        {
          label: "Received by",
          value: resolveRecipientName({
            received_by_contact: row.received_by_contact ?? null,
            received_by: row.received_by,
          }),
        },
        { label: "Source SO", value: row.sales_order_id },
      ] : undefined}
      lineColumns={columns}
      lineRows={rows}
      activity={row ? [
        { id: "created", at: fmt(row.created_at), actor: "System", title: `Delivery ${row.delivery_number} created` },
        ...(row.delivered_at ? [{ id: "delivered", at: fmt(row.delivered_at), title: "Delivered", tone: "success" as const }] : []),
      ] : undefined}
      extraSections={row ? <DocumentVersionsSection documentType="delivery_note" documentId={row.id} /> : undefined}
    />
  );
}