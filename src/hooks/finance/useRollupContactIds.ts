/**
 * useRollupContactIds — single, query-cached entry point for the
 * commercial-partner rollup rule documented in ADR-0038.
 *
 * Reporting views (AR/AP balance, statements, dunning) widen a contact id
 * into the full `commercial_partner_id` family when the user opts in.
 * Posting paths must NEVER use this — they record against the actual
 * `customer_id`/`vendor_id` to preserve audit lineage.
 *
 * The hook is the only call site of `expandToCommercialPartnerSet` outside
 * Statements + AR/AP aging rollup, so the rule stays in one place.
 */

import { useQuery } from "@tanstack/react-query";
import { expandToCommercialPartnerSet } from "@/lib/contactHierarchy";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export function useRollupContactIds(
  contactId: string | null | undefined,
  enabled: boolean,
) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  return useQuery({
    queryKey: [
      "contact-rollup-ids",
      contactId,
      enabled,
      currentOrg?.id,
      currentBusiness?.id,
    ],
    queryFn: async (): Promise<string[]> => {
      if (!contactId) return [];
      if (!enabled || !currentOrg?.id || !currentBusiness?.id) {
        return [contactId];
      }
      return expandToCommercialPartnerSet(contactId, {
        organizationId: currentOrg.id,
        businessId: currentBusiness.id,
      });
    },
    enabled: !!contactId,
    staleTime: 60_000,
  });
}
