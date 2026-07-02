/**
 * Business-scoped query helpers — ensure business_id is always included
 * in Supabase queries on company-scoped tables (tax_rates, tax_groups,
 * organization_payment_methods, document_templates, accounts, etc.).
 *
 * Companion to orgScopedQuery.ts. Use BOTH when querying a table that
 * carries both organization_id and business_id.
 */

/**
 * Validates that a business_id is present. Use before any Supabase call
 * to a company-scoped table to prevent cross-business data leaks.
 *
 * Usage:
 *   requireBusinessId(currentBusiness?.id, "fetchTaxGroups");
 *   const { data } = await supabase.from("tax_groups")
 *     .select("*")
 *     .eq("organization_id", currentOrg.id)
 *     .eq("business_id", currentBusiness.id);
 */
export function requireBusinessId(
  businessId: string | undefined | null,
  context?: string
): asserts businessId is string {
  if (!businessId) {
    throw new Error(
      `Missing business_id${context ? ` in ${context}` : ""}. ` +
        "This is a company-isolation requirement — select a Company first."
    );
  }
}