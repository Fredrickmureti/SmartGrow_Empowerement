/**
 * DeliverToPicker — "where should the supplier deliver these goods?"
 *
 * This is OUR location (a warehouse or a branch), never the supplier's
 * address. It reads `@/lib/internalDestinations`; it must never consume
 * `contactAddresses`, and the supplier's own address continues to be
 * rendered from the contact record in the vendor block of the PO.
 *
 * Persisted as a triple:
 *   - `deliverToWarehouseId` / `deliverToBranchId` — the structured link
 *   - `shippingAddress` — the rendered SNAPSHOT printed on the PO
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Warehouse as WarehouseIcon, PencilLine } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  destinationKey,
  findDestinationByKey,
  formatInternalDestination,
  listInternalDestinations,
  type InternalDestination,
} from "@/lib/internalDestinations";

const CUSTOM = "__custom__";

export interface DeliverToValue {
  deliverToWarehouseId: string | null;
  deliverToBranchId: string | null;
  shippingAddress: string;
}

interface DeliverToPickerProps {
  businessId: string | null | undefined;
  value: DeliverToValue;
  onChange: (value: DeliverToValue) => void;
  disabled?: boolean;
}

export function DeliverToPicker({
  businessId,
  value,
  onChange,
  disabled = false,
}: DeliverToPickerProps) {
  const { data: destinations = [] } = useQuery({
    queryKey: ["internal-destinations", businessId],
    queryFn: () => listInternalDestinations(businessId),
    enabled: Boolean(businessId),
  });

  const [isCustom, setIsCustom] = useState(
    () =>
      !value.deliverToWarehouseId &&
      !value.deliverToBranchId &&
      Boolean(value.shippingAddress),
  );

  const selectedKey = useMemo(() => {
    if (isCustom) return CUSTOM;
    if (value.deliverToWarehouseId) return `warehouse:${value.deliverToWarehouseId}`;
    if (value.deliverToBranchId) return `branch:${value.deliverToBranchId}`;
    return "";
  }, [isCustom, value.deliverToBranchId, value.deliverToWarehouseId]);

  // Default to the single available destination when there is only one.
  useEffect(() => {
    if (isCustom || selectedKey || destinations.length !== 1) return;
    apply(destinations[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinations]);

  const apply = (destination: InternalDestination) => {
    setIsCustom(false);
    onChange({
      deliverToWarehouseId:
        destination.kind === "warehouse" ? destination.id : null,
      deliverToBranchId: destination.kind === "branch" ? destination.id : null,
      shippingAddress: formatInternalDestination(destination),
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5">
          <WarehouseIcon className="h-3.5 w-3.5 text-muted-foreground" />
          Deliver to
        </Label>
        {isCustom ? (
          <Badge variant="outline" className="gap-1 text-xs font-normal">
            <PencilLine className="h-3 w-3" />
            Custom destination
          </Badge>
        ) : selectedKey ? (
          <Badge variant="secondary" className="text-xs font-normal">
            Our location
          </Badge>
        ) : null}
      </div>

      <Select
        value={selectedKey}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === CUSTOM) {
            setIsCustom(true);
            onChange({
              deliverToWarehouseId: null,
              deliverToBranchId: null,
              shippingAddress: value.shippingAddress,
            });
            return;
          }
          const destination = findDestinationByKey(destinations, next);
          if (destination) apply(destination);
        }}
      >
        <SelectTrigger>
          <SelectValue placeholder="Where should the supplier deliver?" />
        </SelectTrigger>
        <SelectContent>
          {destinations.map((destination) => (
            <SelectItem
              key={destinationKey(destination)}
              value={destinationKey(destination)}
            >
              {destination.name}
              {destination.kind === "branch" ? " (branch)" : " (warehouse)"}
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
            ? "Type the one-off receiving address"
            : "Select one of your warehouses or branches"
        }
        className={!isCustom ? "bg-muted/40" : undefined}
        onChange={(event) =>
          onChange({
            deliverToWarehouseId: null,
            deliverToBranchId: null,
            shippingAddress: event.target.value,
          })
        }
      />
      <p className="text-xs text-muted-foreground">
        This is where you ask the supplier to deliver — not the supplier's own
        address.
      </p>
    </div>
  );
}

export default DeliverToPicker;
