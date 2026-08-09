/**
 * ShipToPicker — the ONE ship-to selection surface for sales documents.
 *
 * Resolves the customer's saved addresses through
 * `@/lib/contactAddresses` (the single resolver), preselects the party's
 * default delivery address, and lets the user pick another saved address
 * or fall back to a one-off custom address.
 *
 * Provenance is never hidden: the control states whether the address came
 * from the customer's address book or was typed for this document only.
 *
 * The value the caller persists is a pair:
 *   - `shipToContactId` — the saved address that was chosen (null when custom)
 *   - `shippingAddress` — the rendered text, which is the document's SNAPSHOT.
 *     Later edits to master data must not change it.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, PencilLine } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addressOptionLabel,
  formatAddress,
  isEmptyAddress,
  listPartyAddresses,
  pickAddressForRole,
  type PartyAddress,
} from "@/lib/contactAddresses";

const CUSTOM = "__custom__";

export interface ShipToValue {
  shipToContactId: string | null;
  shippingAddress: string;
}

interface ShipToPickerProps {
  /** The document's customer. Addresses are scoped to this party. */
  contactId: string | null | undefined;
  value: ShipToValue;
  onChange: (value: ShipToValue) => void;
  label?: string;
  disabled?: boolean;
  /**
   * When true the picker will not overwrite an address that is already
   * present (used by edit pages so a stored snapshot is preserved).
   */
  preserveExisting?: boolean;
}

export function ShipToPicker({
  contactId,
  value,
  onChange,
  label = "Ship to",
  disabled = false,
  preserveExisting = false,
}: ShipToPickerProps) {
  const { data: addresses = [], isLoading } = useQuery({
    queryKey: ["party-addresses", contactId],
    queryFn: () => listPartyAddresses(contactId),
    enabled: Boolean(contactId),
  });

  const [isCustom, setIsCustom] = useState(
    () => !value.shipToContactId && Boolean(value.shippingAddress),
  );
  const [autoAppliedFor, setAutoAppliedFor] = useState<string | null>(
    preserveExisting ? (contactId ?? null) : null,
  );

  const selectable = useMemo(
    () => addresses.filter((a) => !isEmptyAddress(a) || a.is_party_itself),
    [addresses],
  );

  // Preselect the party's default ship-to when the customer changes.
  useEffect(() => {
    if (!contactId || isLoading) return;
    if (autoAppliedFor === contactId) return;
    setAutoAppliedFor(contactId);

    if (isCustom) return;

    const preferred = pickAddressForRole(addresses, "shipping");
    if (!preferred || isEmptyAddress(preferred)) {
      onChange({ shipToContactId: null, shippingAddress: "" });
      return;
    }
    onChange({
      shipToContactId: preferred.id,
      shippingAddress: formatAddress(preferred, { includeName: true }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, isLoading, addresses]);

  const applySaved = (address: PartyAddress) => {
    setIsCustom(false);
    onChange({
      shipToContactId: address.id,
      shippingAddress: formatAddress(address, { includeName: true }),
    });
  };

  const selectValue = isCustom ? CUSTOM : (value.shipToContactId ?? "");

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
          {label}
        </Label>
        {isCustom ? (
          <Badge variant="outline" className="gap-1 text-xs font-normal">
            <PencilLine className="h-3 w-3" />
            Custom delivery address
          </Badge>
        ) : value.shipToContactId ? (
          <Badge variant="secondary" className="text-xs font-normal">
            From customer address book
          </Badge>
        ) : null}
      </div>

      <Select
        value={selectValue}
        disabled={disabled || !contactId}
        onValueChange={(next) => {
          if (next === CUSTOM) {
            setIsCustom(true);
            onChange({ shipToContactId: null, shippingAddress: value.shippingAddress });
            return;
          }
          const address = selectable.find((a) => a.id === next);
          if (address) applySaved(address);
        }}
      >
        <SelectTrigger>
          <SelectValue
            placeholder={
              contactId ? "Select a delivery address" : "Select a customer first"
            }
          />
        </SelectTrigger>
        <SelectContent>
          {selectable.map((address) => (
            <SelectItem key={address.id} value={address.id}>
              {addressOptionLabel(address)}
              {address.is_default_shipping ? " • default" : ""}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>Use a custom address…</SelectItem>
        </SelectContent>
      </Select>

      <Textarea
        value={value.shippingAddress}
        readOnly={!isCustom}
        disabled={disabled}
        rows={3}
        placeholder={
          isCustom
            ? "Type the one-off delivery address"
            : "No address on file for this customer"
        }
        className={!isCustom ? "bg-muted/40" : undefined}
        onChange={(event) =>
          onChange({ shipToContactId: null, shippingAddress: event.target.value })
        }
      />

      {!isCustom && contactId && selectable.length <= 1 && (
        <p className="text-xs text-muted-foreground">
          This customer has no saved delivery addresses yet. Add them on the
          contact record so they can be reused.{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => setIsCustom(true)}
          >
            Use a custom address instead
          </Button>
        </p>
      )}
    </div>
  );
}

export default ShipToPicker;
