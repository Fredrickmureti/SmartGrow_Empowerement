/**
 * ContactAddressBook — the party's saved addresses.
 *
 * Renders the child `contacts` rows of a party (ADR-0038 hierarchy,
 * `child_address_type` = invoice | delivery | contact | other) and lets
 * the user nominate the default bill-to / ship-to. A DB trigger keeps a
 * single default of each kind per parent, so this UI simply writes the
 * flag and refetches.
 *
 * This is the ONLY place addresses are maintained. Documents never
 * create addresses; they select one through
 * `@/components/addresses/ShipToPicker` and snapshot the rendered text.
 *
 * Only available on an existing party (create-mode contacts have no id
 * to parent to yet) and only on a root contact — a child address cannot
 * itself own an address book.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MapPin, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useOrganization } from "@/hooks/useOrganization";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  formatAddress,
  listPartyAddresses,
  type ContactAddressRole,
  type PartyAddress,
} from "@/lib/contactAddresses";

interface ContactAddressBookProps {
  /** Root party whose addresses these are. */
  contactId: string;
  partyName: string;
}

interface AddressDraft {
  id: string | null;
  name: string;
  child_address_type: ContactAddressRole;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  email: string;
  phone: string;
}

const emptyDraft = (): AddressDraft => ({
  id: null,
  name: "",
  child_address_type: "delivery",
  address_line1: "",
  address_line2: "",
  city: "",
  state: "",
  postal_code: "",
  country: "",
  email: "",
  phone: "",
});

const ROLE_LABEL: Record<ContactAddressRole, string> = {
  delivery: "Delivery address",
  invoice: "Invoice address",
  contact: "Contact person",
  other: "Other",
};

export function ContactAddressBook({
  contactId,
  partyName,
}: ContactAddressBookProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const [draft, setDraft] = useState<AddressDraft | null>(null);

  const queryKey = ["party-addresses", contactId];
  const { data: addresses = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => listPartyAddresses(contactId),
  });

  const children = addresses.filter((a) => !a.is_party_itself);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ["contacts"] });
    // The address change is a master-data business event: its projections
    // (the 360° profile and the hierarchy tree) must follow it.
    queryClient.invalidateQueries({ queryKey: ["contact-profile", contactId] });
    queryClient.invalidateQueries({ queryKey: ["contact-hierarchy"] });
  };


  const failed = (error: unknown) =>
    toast({
      title: "Address not saved",
      description: normalizeError(error).message,
      variant: "destructive",
    });

  const saveMutation = useMutation({
    mutationFn: async (value: AddressDraft) => {
      const payload = {
        name: value.name.trim(),
        child_address_type: value.child_address_type,
        address_line1: value.address_line1 || null,
        address_line2: value.address_line2 || null,
        city: value.city || null,
        state: value.state || null,
        postal_code: value.postal_code || null,
        country: value.country || null,
        email: value.email || null,
        phone: value.phone || null,
      };

      if (value.id) {
        const { error } = await supabase
          .from("contacts")
          .update(payload)
          .eq("id", value.id);
        if (error) throw error;
        return;
      }

      if (!currentBusiness || !currentOrg) {
        throw new Error("No business selected");
      }
      const { error } = await supabase.from("contacts").insert({
        ...payload,
        parent_contact_id: contactId,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        is_company: false,
        is_active: true,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      setDraft(null);
      invalidate();
      toast({ title: "Address saved" });
    },
    onError: failed,
  });

  const defaultMutation = useMutation({
    mutationFn: async ({
      address,
      role,
    }: {
      address: PartyAddress;
      role: "shipping" | "billing";
    }) => {
      const patch =
        role === "shipping"
          ? { is_default_shipping: !address.is_default_shipping }
          : { is_default_billing: !address.is_default_billing };
      const { error } = await supabase
        .from("contacts")
        .update(patch)
        .eq("id", address.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: failed,
  });

  const deleteMutation = useMutation({
    mutationFn: async (address: PartyAddress) => {
      const { error } = await supabase
        .from("contacts")
        .delete()
        .eq("id", address.id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Address removed" });
    },
    onError: (error) =>
      toast({
        title: "Address still in use",
        description: normalizeError(error).message,
        variant: "destructive",
      }),
  });

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            Addresses
          </h3>
          <p className="text-xs text-muted-foreground">
            Saved delivery and invoice addresses for {partyName || "this party"}.
            Documents pick from this list and keep a snapshot of what was
            printed.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDraft(emptyDraft())}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add address
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading addresses…
        </div>
      ) : children.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          No saved addresses yet — documents will use the main address above.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {children.map((address) => (
            <li
              key={address.id}
              className="flex flex-wrap items-start justify-between gap-3 p-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{address.name}</span>
                  <Badge variant="outline" className="text-xs font-normal">
                    {ROLE_LABEL[address.child_address_type ?? "other"]}
                  </Badge>
                  {address.is_default_shipping && (
                    <Badge variant="secondary" className="text-xs font-normal">
                      Default ship-to
                    </Badge>
                  )}
                  {address.is_default_billing && (
                    <Badge variant="secondary" className="text-xs font-normal">
                      Default bill-to
                    </Badge>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">
                  {formatAddress(address) || "No postal details"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  title="Set as default ship-to"
                  onClick={() =>
                    defaultMutation.mutate({ address, role: "shipping" })
                  }
                >
                  <Star
                    className={
                      address.is_default_shipping
                        ? "h-3.5 w-3.5 fill-current"
                        : "h-3.5 w-3.5"
                    }
                  />
                  <span className="ml-1 text-xs">Ship</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  title="Set as default bill-to"
                  onClick={() =>
                    defaultMutation.mutate({ address, role: "billing" })
                  }
                >
                  <Star
                    className={
                      address.is_default_billing
                        ? "h-3.5 w-3.5 fill-current"
                        : "h-3.5 w-3.5"
                    }
                  />
                  <span className="ml-1 text-xs">Bill</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Edit address"
                  onClick={() =>
                    setDraft({
                      id: address.id,
                      name: address.name,
                      child_address_type:
                        address.child_address_type ?? "delivery",
                      address_line1: address.address_line1 ?? "",
                      address_line2: address.address_line2 ?? "",
                      city: address.city ?? "",
                      state: address.state ?? "",
                      postal_code: address.postal_code ?? "",
                      country: address.country ?? "",
                      email: address.email ?? "",
                      phone: address.phone ?? "",
                    })
                  }
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove address"
                  onClick={() => deleteMutation.mutate(address)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={Boolean(draft)} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {draft?.id ? "Edit address" : "Add address"}
            </DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="addr-name">Label *</Label>
                <Input
                  id="addr-name"
                  value={draft.name}
                  placeholder="Warehouse — Mombasa Road"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Type</Label>
                <Select
                  value={draft.child_address_type}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      child_address_type: value as ContactAddressRole,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="delivery">Delivery address</SelectItem>
                    <SelectItem value="invoice">Invoice address</SelectItem>
                    <SelectItem value="contact">Contact person</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="addr-l1">Address line 1</Label>
                <Input
                  id="addr-l1"
                  value={draft.address_line1}
                  onChange={(e) =>
                    setDraft({ ...draft, address_line1: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="addr-l2">Address line 2</Label>
                <Input
                  id="addr-l2"
                  value={draft.address_line2}
                  onChange={(e) =>
                    setDraft({ ...draft, address_line2: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="addr-city">City</Label>
                <Input
                  id="addr-city"
                  value={draft.city}
                  onChange={(e) => setDraft({ ...draft, city: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="addr-state">State</Label>
                <Input
                  id="addr-state"
                  value={draft.state}
                  onChange={(e) => setDraft({ ...draft, state: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="addr-postal">Postal code</Label>
                <Input
                  id="addr-postal"
                  value={draft.postal_code}
                  onChange={(e) =>
                    setDraft({ ...draft, postal_code: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="addr-country">Country</Label>
                <Input
                  id="addr-country"
                  value={draft.country}
                  onChange={(e) =>
                    setDraft({ ...draft, country: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="addr-email">Email</Label>
                <Input
                  id="addr-email"
                  type="email"
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="addr-phone">Phone</Label>
                <Input
                  id="addr-phone"
                  value={draft.phone}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!draft?.name.trim() || saveMutation.isPending}
              onClick={() => draft && saveMutation.mutate(draft)}
            >
              {saveMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save address
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ContactAddressBook;
