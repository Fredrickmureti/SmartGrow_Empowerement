/**
 * Canonical read seam for product identifiers.
 *
 * Identifiers have a lifecycle (`active | inactive | archived`). Retiring an
 * identifier archives the row rather than deleting it, so any read that omits
 * the status predicate renders retired codes as if they were live — the
 * "deleted identifiers come back" and "overview shows duplicates" defects.
 *
 * Every surface that lists identifiers for operators MUST go through this
 * helper. Surfaces that deliberately show retired history should filter
 * explicitly and say so in a comment.
 *
 * Guard: src/test/architecture/identity-read-lifecycle.test.ts
 */
import { supabase } from "@/integrations/supabase/client";

export const ACTIVE_IDENTIFIER_STATUS = "active" as const;

/** Columns every operator-facing identifier list needs. */
export const IDENTIFIER_LIST_COLUMNS =
  "id, code, kind, is_primary, packaging_id, supplier_id, status" as const;

/**
 * Active identifiers for one product, ordered primary-first then by capture
 * order — the order operators expect in both the editor and the overview.
 */
export function activeIdentifiersForProduct(productId: string, columns: string = IDENTIFIER_LIST_COLUMNS) {
  return supabase
    .from("product_identifiers")
    .select(columns)
    .eq("product_id", productId)
    .eq("status", ACTIVE_IDENTIFIER_STATUS)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });
}
