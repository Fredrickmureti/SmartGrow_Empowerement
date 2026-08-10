/**
 * ContactAddressesSection — read-only projection of a party's canonical
 * addresses on the Contact 360° profile.
 *
 * Consumes the single canonical resolver through `useContactAddresses`
 * (ADR-0038 / ADR-0080): the party's own row plus its child address rows,
 * labelled by `child_address_type` and flagged by
 * `is_default_billing` / `is_default_shipping`. It owns no query and no
 * formatting of its own — editing happens in the address book.
 */
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { useContactAddresses } from "@/hooks/useContactAddresses";
import { formatAddressInline, isEmptyAddress } from "@/lib/contactAddresses";

const ROLE_LABEL: Record<string, string> = {
  delivery: "Delivery",
  invoice: "Invoice",
  contact: "Contact",
  other: "Other",
};

export function ContactAddressesSection({ contactId }: { contactId: string }) {
  const { addresses, isLoading } = useContactAddresses(contactId);

  if (isLoading) {
    return (
      <div className="sm:col-span-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading addresses…
      </div>
    );
  }

  const visible = addresses.filter((a) => !isEmptyAddress(a));
  if (visible.length === 0) return null;

  return (
    <div className="sm:col-span-2">
      <p className="text-xs text-muted-foreground mb-2">Addresses</p>
      <ul className="space-y-2">
        {visible.map((address) => (
          <li
            key={address.id}
            className="rounded-md border p-3 flex flex-col gap-1"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {address.is_party_itself
                  ? "Main address"
                  : address.name || "Address"}
              </span>
              {!address.is_party_itself && address.child_address_type && (
                <Badge variant="secondary">
                  {ROLE_LABEL[address.child_address_type] ??
                    address.child_address_type}
                </Badge>
              )}
              {address.is_default_billing && (
                <Badge variant="outline">Default billing</Badge>
              )}
              {address.is_default_shipping && (
                <Badge variant="outline">Default delivery</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {formatAddressInline(address)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
