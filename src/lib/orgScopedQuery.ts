/**
 * Org-scoped query helpers — ensure organization_id is always included
 * in Supabase queries on multi-tenant tables.
 */

/**
 * Validates that an org_id is present. Use before any Supabase call
 * to prevent cross-org data leaks.
 * 
 * Usage:
 *   requireOrgId(currentOrg?.id, "fetchInvoices");
 *   // SCOPE-EXEMPT: this is documentation example only — not executed code
 *   const { data } = await supabase.from("invoices")
 *     .select("*")
 *     .eq("organization_id", currentOrg.id)
 *     .eq("business_id", currentBusiness.id);
 */
export function requireOrgId(
  orgId: string | undefined | null,
  context?: string
): asserts orgId is string {
  if (!orgId) {
    throw new Error(
      `Missing organization_id${context ? ` in ${context}` : ""}. ` +
        "This is a multi-tenant isolation requirement."
    );
  }
}
