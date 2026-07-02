/**
 * Branch-aware client wrapper around the `resolve_default_account` RPC.
 *
 * Always prefer this helper over a direct `select … from default_accounts`
 * when picking an account for posting/journalling — it preserves the
 * inherit-with-override semantics of Wave D:
 *   1. If a row exists for (business_id, purpose, branch_id) it wins.
 *   2. Otherwise the company-default row (branch_id IS NULL) is returned.
 *   3. Otherwise the legacy heuristics kick in (inventory / opening_equity).
 *
 * Callers must pass the document's `branch_id` (NOT the active UI branch),
 * since the source of truth is the entity being posted — a sales invoice
 * raised on Branch A must resolve A's overrides even if the operator is
 * now in Branch B context.
 */
import { supabase } from "@/integrations/supabase/client";

export async function resolveDefaultAccount(
  businessId: string,
  purpose: string,
  branchId: string | null,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("resolve_default_account" as any, {
    p_business_id: businessId,
    p_purpose: purpose,
    p_branch_id: branchId,
  } as any);
  if (error) throw error;
  return (data as string | null) ?? null;
}