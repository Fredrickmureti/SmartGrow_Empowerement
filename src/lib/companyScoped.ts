/**
 * Company-scoped query helper.
 *
 * Every multi-tenant query against a table that carries `business_id` MUST
 * use this helper so that the second filter is never forgotten. Filtering by
 * `organization_id` alone leaks data across companies in the same workspace —
 * see the architecture audit (Phase 5, B1) for the full rationale.
 *
 * Usage:
 *   import { scopedToCompany } from "@/lib/companyScoped";
 *   const { data } = await scopedToCompany(
 *     supabase.from("invoices").select("*"),
 *     currentOrg.id,
 *     currentBusiness.id,
 *   );
 *
 * If you genuinely need cross-company data (admin tooling, consolidation),
 * skip the helper and add a code comment explaining why.
 */
import { requireOrgId } from "./orgScopedQuery";
import { requireBusinessId } from "./businessScopedQuery";

export function scopedToCompany<T extends { eq: (col: string, val: any) => T }>(
  query: T,
  orgId: string | undefined | null,
  businessId: string | undefined | null,
  context?: string,
): T {
  requireOrgId(orgId, context);
  requireBusinessId(businessId, context);
  return query.eq("organization_id", orgId).eq("business_id", businessId);
}