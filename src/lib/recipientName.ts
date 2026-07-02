/**
 * Shared recipient-name resolution helpers for both the sales-side
 * Delivery Note (`delivery_notes.received_by` legacy free text +
 * `received_by_user_id` + `received_by_contact_id`) and the purchases-side
 * Goods Receipt (`goods_receipts.received_by` uuid → profiles).
 *
 * UUIDs MUST NEVER reach the rendered UI. Every render surface that touches
 * a "received_by" column goes through one of these resolvers — enforced by
 * the `local/no-raw-received-by-render` ESLint rule.
 *
 * The DN resolver was previously inlined in `looksLikeUUID.ts`; that module
 * now re-exports from here for backwards compatibility.
 */

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function looksLikeUUID(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/**
 * Delivery Note recipient. Priority (highest first):
 *   1. linked contact      (received_by_contact.name)
 *   2. proof-of-delivery   (delivery_proofs[0].received_by_name)
 *   3. linked staff user   (profile.full_name via received_by_user_id)
 *   4. legacy free-text    (delivery_notes.received_by)
 * Returns `null` so callers can render "—".
 */
export function resolveRecipientName(input: {
  received_by_contact?: { name?: string | null } | null;
  delivery_proof_name?: string | null;
  received_by_user?: { full_name?: string | null } | null;
  received_by?: string | null;
}): string | null {
  const contactName = input.received_by_contact?.name?.trim();
  if (contactName) return contactName;

  const podName = input.delivery_proof_name?.trim();
  if (podName && !looksLikeUUID(podName)) return podName;

  const userName = input.received_by_user?.full_name?.trim();
  if (userName && !looksLikeUUID(userName)) return userName;

  const legacy = input.received_by?.trim();
  if (legacy && !looksLikeUUID(legacy)) return legacy;

  return null;
}

/**
 * Goods-Receipt recipient. `goods_receipts.received_by` is uuid-typed (FK to
 * auth.users) so the raw column MUST be resolved through profiles before
 * rendering. Callers join `profiles` on `user_id = received_by` and pass the
 * result here.
 *
 * Priority:
 *   1. resolved staff name (profile.full_name)
 *   2. nothing — never render the raw uuid.
 */
export function resolveGoodsReceiptRecipient(input: {
  received_by_user?: { full_name?: string | null } | null;
  received_by?: string | null;
}): string | null {
  const userName = input.received_by_user?.full_name?.trim();
  if (userName && !looksLikeUUID(userName)) return userName;

  // Defense-in-depth: any non-uuid free text (legacy rows pre-uuid migration).
  const legacy = input.received_by?.trim();
  if (legacy && !looksLikeUUID(legacy)) return legacy;

  return null;
}

/**
 * Strip the legacy `[auto-from-invoice:<uuid>]` token and the
 * `Auto-created from invoice …` prefix from a notes blob, in case the
 * one-shot backfill missed a row or a future write reintroduces the marker.
 */
export function stripDeliveryNoteSystemTokens(
  notes: string | null | undefined,
): string | null {
  if (!notes) return null;
  const cleaned = notes
    .replace(
      /\s*Auto-created from invoice [^\[\n]*\[auto-from-invoice:[0-9a-fA-F-]{36}\]\s*(\(backfill\))?\s*/g,
      "",
    )
    .replace(/\s*\[auto-from-invoice:[0-9a-fA-F-]{36}\]\s*/g, "")
    .trim();
  return cleaned || null;
}