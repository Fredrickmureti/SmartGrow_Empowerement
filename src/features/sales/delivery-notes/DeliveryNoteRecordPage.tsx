/**
 * DeliveryNoteRecordPage — object-page route for a Delivery Note.
 * Read-only, powered by RecordScaffold.
 */

import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";
import { ArrowLeft, FileSearch, Printer, XCircle } from "lucide-react";

import { ActionBar, Section, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { RecordScaffold } from "@/design-system/records";
import type { LineItemColumn, LineItemRow } from "@/design-system/records";
import type { DeliveryNote, DeliveryNoteItem } from "@/hooks/useDeliveryNotes";
import { useDeliveryNotes } from "@/hooks/useDeliveryNotes";
import { useDeliveryNoteRecord } from "./useDeliveryNoteRecord";
import { useDeliveryNoteLineBalances } from "./useDeliveryNoteLineBalances";
import { usePrintDeliveryNote } from "./usePrintDeliveryNote";
import { resolveRecipientName } from "@/lib/looksLikeUUID";
import { AddressBlock } from "@/components/addresses/AddressBlock";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";
import { useDocumentPreview } from "@/components/documents/DocumentPreviewProvider";
import { DeliveryLogisticsPanel } from "@/components/sales/DeliveryLogisticsPanel";
import { isFinalDeliveryStatus } from "@/types/deliveryNote";

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
  const navigate = useNavigate();
  const isNew = id === "new";
  // Single reader for the delivery note record — shared with the peek sheet
  // so the two surfaces cannot drift (and so the contacts embed is
  // disambiguated in exactly one place).
  const { record, loading, error, refetch } = useDeliveryNoteRecord(isNew ? null : id);
  const row = record as Row | null;
  const notFound = !loading && !isNew && !row;
  const printDeliveryNote = usePrintDeliveryNote();
  const { preview } = useDocumentPreview();
  const { cancelDelivery } = useDeliveryNotes();
  const isFinal = isFinalDeliveryStatus(row?.status);
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

  // Print is always available for a persisted record: it is an output event
  // over the canonical snapshot, independent of lifecycle state.
  const onPrint = row
    ? () => printDeliveryNote({ id: row.id, delivery_number: row.delivery_number })
    : undefined;

  // Preview is a read-only render of the canonical snapshot — no document
  // record, no device dispatch.
  const onPreview = row
    ? () =>
        preview({
          documentType: "delivery_note",
          documentId: row.id,
          title: `Delivery Note ${row.delivery_number}`,
          filename: `delivery-note-${row.delivery_number}`,
        })
    : undefined;

  const headerActions = row ? (
    <ActionBar>
      <Button variant="outline" size="sm" onClick={() => navigate("/sales/delivery-notes")}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back
      </Button>
      <Button variant="outline" size="sm" onClick={onPreview}>
        <FileSearch className="mr-2 h-4 w-4" /> Preview
      </Button>
      <Button variant="outline" size="sm" onClick={onPrint}>
        <Printer className="mr-2 h-4 w-4" /> Print
      </Button>
      {!isFinal && (
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await cancelDelivery(row.id, null);
            refetch();
          }}
        >
          <XCircle className="mr-2 h-4 w-4" /> Cancel delivery
        </Button>
      )}
    </ActionBar>
  ) : undefined;

  return (
    <RecordScaffold
      eyebrow="Delivery Note"
      listPath="/sales/delivery-notes"
      id={id}
      loading={loading}
      error={notFound ? null : error}
      notFound={notFound}
      newLabel="New delivery note"
      onPrint={onPrint}
      onPreview={onPreview}
      headerActions={headerActions}
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
        {
          label: "Ship to",
          value: (
            <AddressBlock
              address={row.shipping_address}
              provenance={
                      row.ship_to_contact_id
                        ? "address_book"
                        : row.sales_order_id && row.shipping_address
                          ? "inherited"
                          : row.shipping_address
                            ? "custom"
                            : "none"
                    }
            />
          ),
        },
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
      extraSections={row ? (
        <>
          {/* Lifecycle, logistics, POD and partial delivery all run through the
              SECURITY DEFINER engines inside this panel — never direct writes. */}
          <Section title="Fulfilment">
            <div className="space-y-4">
              <DeliveryLogisticsPanel
                dn={row as never}
                onChanged={refetch}
              />
            </div>
          </Section>
          <DocumentVersionsSection documentType="delivery_note" documentId={row.id} />
        </>
      ) : undefined}
    />
  );
}