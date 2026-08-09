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
  code_taken_same_product: "This product already carries that code on another row.",
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

/**
 * Structured outcome of a write. `duplicate` names the product that already
 * holds the code so the caller can show it; `idempotent` means the same code
 * was already enrolled on the same product and level — a repeated gun
 * trigger, not an operator error.
 */
export type IdentifierWriteResult =
  | { status: "ok"; identifierId: string; idempotent: boolean; revived: boolean }
  | {
      status: "duplicate";
      conflictProductId: string | null;
      conflictProductName: string | null;
      sameProduct: boolean;
      message: string;
    }
  | { status: "invalid"; reason: string | null; message: string };

export async function writeIdentifierResult(
  input: IdentifierWriteInput,
): Promise<IdentifierWriteResult> {
  const code = (input.code || "").trim();
  if (!code) {
    return { status: "invalid", reason: "empty_code", message: REASONS.empty_code };
  }
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
  if (error) {
    return { status: "invalid", reason: null, message: identifierWriteMessage(null) };
  }
  const envelope = (data ?? null) as {
    status?: string;
    reason?: string;
    identifier_id?: string;
    idempotent?: boolean;
    product_id?: string;
    product_name?: string;
  } | null;
  if (envelope?.status === "ok") {
    return {
      status: "ok",
      identifierId: envelope.identifier_id ?? "",
      idempotent: !!envelope.idempotent,
    };
  }
  if (envelope?.status === "duplicate") {
    return {
      status: "duplicate",
      conflictProductId: envelope.product_id ?? null,
      conflictProductName: envelope.product_name ?? null,
      message: identifierWriteMessage(envelope.reason ?? "code_taken"),
    };
  }
  return {
    status: "invalid",
    reason: envelope?.reason ?? null,
    message: identifierWriteMessage(envelope?.reason),
  };
}

export async function writeIdentifier(input: IdentifierWriteInput): Promise<string | null> {
  const result = await writeIdentifierResult(input);
  return result.status === "ok" ? null : result.message;
}

/**
 * Canonical retire seam. Deleting an identifier row destroys the audit
 * trail and lets a code silently re-resolve later; archiving keeps the
 * history and frees the code for re-issue via the partial unique index.
 */
export async function retireIdentifier(input: {
  businessId: string;
  identifierId: string;
  status?: "inactive" | "archived";
  replacedById?: string | null;
}): Promise<string | null> {
  const { data, error } = await supabase.rpc("retire_product_identifier" as never, {
    p_business_id: input.businessId,
    p_identifier_id: input.identifierId,
    p_status: input.status ?? "archived",
    p_replaced_by_id: input.replacedById ?? undefined,
  } as never);
  if (error) return identifierWriteMessage(null);
  const envelope = (data ?? null) as { status?: string; reason?: string } | null;
  if (envelope?.status && envelope.status !== "ok") {
    return identifierWriteMessage(envelope.reason);
  }
  return null;
}