/**
 * useContactHierarchy — surfaces the commercial-partner tree for the
 * Contact profile.
 *
 * One query keyed by `commercial_partner_id` returns:
 *   - parent  : the root company (null when the contact is the root)
 *   - children: direct children when the contact is a company
 *   - siblings: other contacts sharing the same commercial partner
 *
 * The trigger that maintains `commercial_partner_id` guarantees that every
 * contact in a tree carries the same value, so a single SELECT is enough.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface ContactHierarchyNode {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  is_company: boolean;
  parent_contact_id: string | null;
  commercial_partner_id: string | null;
  child_address_type: string | null;
}

export interface ContactHierarchy {
  self: ContactHierarchyNode | null;
  parent: ContactHierarchyNode | null;
  children: ContactHierarchyNode[];
  siblings: ContactHierarchyNode[];
  isLoading: boolean;
}

export function useContactHierarchy(
  contactId: string | null,
  commercialPartnerId: string | null | undefined,
): ContactHierarchy {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  // Tree root — the value `commercial_partner_id` points at. For a contact
  // that IS the root, this equals its own id. For an orphan with no rank-up
  // trigger yet, fall back to the contact id so we still pull self.
  const root = commercialPartnerId || contactId;
  const enabled =
    !!contactId && !!root && !!currentOrg?.id && !!currentBusiness?.id;

  const { data, isLoading } = useQuery({
    queryKey: ["contact-hierarchy", root, currentOrg?.id, currentBusiness?.id],
    queryFn: async () => {
      if (!root || !currentOrg?.id || !currentBusiness?.id) return [];
      // Pull everyone in the commercial partner tree in a single round-trip.
      const { data, error } = await supabase
        .from("contacts")
        .select(
          "id, name, email, phone, is_company, parent_contact_id, commercial_partner_id, child_address_type",
        )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_active", true)
        .or(`id.eq.${root},commercial_partner_id.eq.${root}`);
      if (error) return [];
      return (data || []) as ContactHierarchyNode[];
    },
    enabled,
  });

  // ADR-0038 / ADR-0080: a row carrying `child_address_type` is an ADDRESS of
  // a party, not a party. It belongs in the owning contact's address book —
  // never in the hierarchy tree, which lists business relationships.
  const all = (data || []).filter((n) => n.child_address_type == null);
  const self = all.find((n) => n.id === contactId) ?? null;
  const parentId = self?.parent_contact_id ?? null;
  const parent = parentId ? all.find((n) => n.id === parentId) ?? null : null;
  const children = self?.is_company
    ? all.filter((n) => n.parent_contact_id === self.id)
    : [];
  const siblings = parentId
    ? all.filter(
        (n) => n.parent_contact_id === parentId && n.id !== contactId,
      )
    : [];


  return { self, parent, children, siblings, isLoading };
}
