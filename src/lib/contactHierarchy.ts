/**
 * Contact hierarchy helpers — Phase 7.
 *
 * Single source of truth for the *commercial-partner rollup rule*.
 *
 * Background (see ADR-0038):
 *   - Every `contacts` row carries a `commercial_partner_id` pointing at the
 *     root of its parent chain (self when the row is itself a company / has
 *     no parent). The column is maintained by the
 *     `set_commercial_partner_id` trigger shipped in migration
 *     `20260424073005`.
 *   - "Statements", AR/AP balances, dunning, and credit checks should
 *     **aggregate** transactions across every contact that shares the same
 *     commercial partner (so a child-contact invoice rolls up to the parent
 *     company's balance).
 *   - **Posting** (invoice/bill creation, payment allocation) must NOT roll
 *     up — those records stay against the actual `customer_id`/`vendor_id`
 *     to preserve audit lineage. This file deliberately does not expose
 *     anything that rewrites a posting key.
 *
 * Consumers must scope every query they build on top of these results by
 * `organization_id` / `business_id` (and, where relevant, `branch_id`) —
 * the helpers themselves only resolve the id family.
 */

import { supabase } from "@/integrations/supabase/client";

/**
 * Resolve the commercial partner id for a contact id.
 * Returns the contact id itself when the row has no parent chain.
 * Throws when the contact cannot be read (caller decides how to handle).
 */
export async function resolveCommercialPartnerId(
  contactId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, commercial_partner_id")
    .eq("id", contactId)
    .single();
  if (error) throw error;
  return (data as any)?.commercial_partner_id || (data as any)?.id || contactId;
}

/**
 * Expand a contact id into the full set of contact ids that share its
 * commercial partner (the parent + every child). Used to widen
 * `.in("customer_id", ids)` / `.in("vendor_id", ids)` queries when a
 * reporting view wants to roll up sub-contacts to the parent company.
 *
 * Scoped by `organization_id` + `business_id` so the rollup never leaks
 * across tenants or sibling legal entities.
 *
 * Always returns a non-empty array — falls back to `[contactId]` if the
 * lookup yields nothing (e.g. RLS hides the family or the contact has
 * been soft-deleted) so callers never accidentally widen a query into
 * an unbounded scan.
 */
export async function expandToCommercialPartnerSet(
  contactId: string,
  scope: { organizationId: string; businessId: string },
): Promise<string[]> {
  const commercialPartnerId = await resolveCommercialPartnerId(contactId);
  const { data, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", scope.organizationId)
    .eq("business_id", scope.businessId)
    .eq("commercial_partner_id", commercialPartnerId);
  if (error) throw error;
  const ids = (data ?? []).map((r: any) => r.id as string);
  return ids.length > 0 ? ids : [contactId];
}
