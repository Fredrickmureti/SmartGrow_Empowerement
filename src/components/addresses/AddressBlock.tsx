/**
 * AddressBlock — the ONE presentation of a document address snapshot.
 *
 * Every record page and peek sheet that shows a ship-to or deliver-to
 * address renders it through this component, so the printed snapshot and
 * its provenance ("from the customer's address book" vs "custom address"
 * vs "our own location") are always described in the same words.
 *
 * This is presentation only. It never resolves an address — resolution
 * lives in `@/lib/contactAddresses` (counterparty) and
 * `@/lib/internalDestinations` (our warehouses / branches).
 */
import { MapPin } from "lucide-react";

export type AddressProvenance =
  | "address_book"
  | "custom"
  | "inherited"
  | "internal"
  | "none";

const PROVENANCE_LABEL: Record<AddressProvenance, string | null> = {
  address_book: "From customer address book",
  custom: "Custom address entered on this document",
  inherited: "Inherited from the source sales order",
  internal: "Our own location",
  none: null,
};

interface AddressBlockProps {
  /** The immutable snapshot text stored on the document. */
  address?: string | null;
  /** Optional heading rendered above the snapshot (e.g. a warehouse name). */
  name?: string | null;
  provenance?: AddressProvenance;
}

export function AddressBlock({
  address,
  name,
  provenance = "none",
}: AddressBlockProps) {
  const note = PROVENANCE_LABEL[provenance];
  const body = (address ?? "").trim();

  if (!body && !name) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <div className="space-y-0.5">
      {name && <div className="font-medium">{name}</div>}
      {body && <div className="whitespace-pre-wrap">{body}</div>}
      {note && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="h-3 w-3 shrink-0" aria-hidden />
          <span>{note}</span>
        </div>
      )}
    </div>
  );
}

export default AddressBlock;
