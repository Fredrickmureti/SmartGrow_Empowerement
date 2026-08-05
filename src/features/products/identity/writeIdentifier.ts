/**
 * Canonical client write seam for product identifiers (ADR-0110).
 *
 * Every enrollment edit — add, correct, re-level, promote to primary —
 * goes through `upsert_product_identifier`, which enforces the invariants
 * that a plain table write cannot: the packaging level must belong to the
 * same product and business, exactly one active identifier may be primary,
 * and a code already live on another product is rejected rather than
 * silently re-pointed.
 *
 * Returns `null` on success, or an operator-facing sentence on failure.
 * Infrastructure detail never reaches the caller.
 */
import { supabase } from "@/integrations/supabase/client";

export interface IdentifierWriteInput {
  businessId: string;
  productId: string;
  code: string;
  kind: string;
  packagingId?: string | null;
  isPrimary?: boolean;
  supplierId?: string | null;
  source?: string | null;
  identifierId?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
}

const REASONS: Record<string, string> = {
  code_taken: "That code is already registered to another product. Retire it there first.",
  duplicate_code: "That code is already registered to another product. Retire it there first.",
  packaging_mismatch: "The chosen packaging level belongs to a different product.",
  invalid_packaging: "The chosen packaging level belongs to a different product.",
  supplier_required: "A supplier code needs a supplier selected.",
  empty_code: "Enter a code before saving.",
  unauthenticated: "Sign in again to change product identifiers.",
  unauthorized: "You do not have permission to change identifiers for this business.",
  not_found: "That identifier no longer exists — refresh and try again.",
};

export function identifierWriteMessage(reason?: string | null): string {
  if (reason && REASONS[reason]) return REASONS[reason];
  return "The identifier could not be saved. Check the code and try again.";
}

export async function writeIdentifier(input: IdentifierWriteInput): Promise<string | null> {
  const code = (input.code || "").trim();
  if (!code) return REASONS.empty_code;
  const { data, error } = await supabase.rpc("upsert_product_identifier" as never, {
    p_business_id: input.businessId,
    p_product_id: input.productId,
    p_code: code,
    p_kind: input.kind,
    p_packaging_id: input.packagingId ?? undefined,
    p_is_primary: input.isPrimary ?? false,
    p_supplier_id: input.supplierId ?? undefined,
    p_source: input.source ?? undefined,
    p_identifier_id: input.identifierId ?? undefined,
    p_valid_from: input.validFrom ?? undefined,
    p_valid_to: input.validTo ?? undefined,
  } as never);
  if (error) return identifierWriteMessage(null);
  const envelope = (data ?? null) as { status?: string; reason?: string } | null;
  if (envelope?.status && envelope.status !== "ok") {
    return identifierWriteMessage(envelope.reason);
  }
  return null;
}