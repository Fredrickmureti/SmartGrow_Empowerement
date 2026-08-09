/**
 * DeliveryNotePeekSheet — standard peek for one delivery note. No totals
 * (delivery notes are quantity-oriented, not amount-oriented).
 */
import { useMemo } from "react";
import { format } from "date-fns";
import { Section } from "@/design-system";
import {
  DocumentActivityPanel,
  DocumentPeekShell,
  DocumentStatusBadge,
  LineItemsGrid,
  type LineItemColumn,
  type LineItemRow,
} from "@/design-system/records";
import type { DeliveryNote } from "@/hooks/useDeliveryNotes";
import { useDeliveryNoteRecord } from "./useDeliveryNoteRecord";
import { AddressBlock } from "@/components/addresses/AddressBlock";
import { DocumentVersionsSection } from "@/components/documents/DocumentVersionsSection";

const fmt = (v?: string | null) => { if (!v) return "—"; try { return format(new Date(v), "PP"); } catch { return v; } };

interface Props { deliveryNoteId: string | null; onOpenChange: (o: boolean) => void; }

export function DeliveryNotePeekSheet({ deliveryNoteId, onOpenChange }: Props) {
  const { record, loading, error } = useDeliveryNoteRecord(deliveryNoteId);

  const columns = useMemo<LineItemColumn[]>(() => [
    { id: "description", header: "Description", width: "minmax(0,1fr)" },
    { id: "ordered", header: "Ordered", width: "90px", numeric: true },
    { id: "delivered", header: "Delivered", width: "100px", numeric: true },
  ], []);

  const rows = useMemo<LineItemRow[]>(() => {
    const items = ((record as any)?.items ?? []) as any[];
    return items.slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((line, idx) => ({
        id: line.id ?? String(idx),
        cells: [
          { columnId: "description", content: line.description || "—" },
          { columnId: "ordered", content: line.quantity_ordered ?? "—" },
          { columnId: "delivered", content: line.quantity_delivered ?? 0 },
        ],
      }));
  }, [record]);

  return (
    <DocumentPeekShell
      open={!!deliveryNoteId}
      onOpenChange={onOpenChange}
      loading={loading}
      error={error}
      errorTitle="Unable to load delivery note"
      title={loading ? "Loading delivery note…" : record ? `Delivery Note ${record.delivery_number}` : "Delivery Note"}
      description={record ? (
        <span className="flex flex-wrap items-center gap-2">
          <DocumentStatusBadge kind="delivery_note" status={record.status} />
          <span className="text-muted-foreground">{record.contact?.name ?? "Customer"}</span>
        </span>
      ) : undefined}
      fullPageHref={record ? `/sales/delivery-notes/${record.id}` : undefined}
    >
      {record && (
        <div className="space-y-5">
          <Section title="Details">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs font-medium text-muted-foreground">Customer</dt><dd className="mt-0.5">{record.contact?.name ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Sales order</dt><dd className="mt-0.5">{(record as any).sales_order?.so_number ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Delivery date</dt><dd className="mt-0.5">{fmt(record.delivery_date)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Delivered at</dt><dd className="mt-0.5">{fmt(record.delivered_at)}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Driver</dt><dd className="mt-0.5">{record.driver_name ?? "—"}</dd></div>
              <div><dt className="text-xs font-medium text-muted-foreground">Vehicle</dt><dd className="mt-0.5">{record.vehicle_number ?? "—"}</dd></div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium text-muted-foreground">Ship to</dt>
                <dd className="mt-0.5">
                  <AddressBlock
                    address={record.shipping_address}
                    provenance={
                      record.ship_to_contact_id
                        ? "address_book"
                        : record.sales_order_id && record.shipping_address
                          ? "inherited"
                          : record.shipping_address
                            ? "custom"
                            : "none"
                    }
                  />
                </dd>
              </div>
            </dl>
          </Section>
          <Section title="Line items"><LineItemsGrid columns={columns} rows={rows} readOnly /></Section>
          <Section title="Activity">
            <DocumentActivityPanel entries={[
              { id: "created", at: fmt(record.created_at), actor: "System", title: `Delivery ${record.delivery_number} created` },
              ...(record.delivered_at ? [{ id: "delivered", at: fmt(record.delivered_at), title: `Delivered${record.received_by ? ` — received by ${record.received_by}` : ""}`, tone: "success" as const }] : []),
            ]} />
          </Section>
          <DocumentVersionsSection documentType="delivery_note" documentId={deliveryNoteId} />
        </div>
      )}
    </DocumentPeekShell>
  );
}
