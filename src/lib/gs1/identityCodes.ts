/**
 * Canonical identity-code normalisation (ADR-0110, Phase 6).
 *
 * ONE grammar, ONE matcher. Every place that has to turn a raw scan into
 * the set of codes that may match `product_identifiers.code_norm` uses
 * this module:
 *
 *   - online   → SQL `public.identity_code_candidates(text)` (mirror)
 *   - offline  → `SQLiteBridge.resolveProductIdentityOffline`
 *   - client   → GS1 interpretation before `resolve_product_identity`
 *
 * The SQL function is a line-for-line mirror of the rules below and both
 * are proven equivalent by the shared vectors in `identityCodeVectors.ts`
 * (`src/test/inventory/identity-code-candidates.test.ts` +
 * `supabase/tests/identity_code_candidates_test.sql`).
 *
 * Rules, in order:
 *   1. `code_norm` is `upper(btrim(code))` — never `lower()`.
 *   2. A GS1 element string contributes its AI (01) GTIN as a candidate.
 *      The full AI grammar lives in `parseGs1.ts` / `aiTable.ts`.
 *   3. GTIN-8/12/13/14 are the same number at different zero padding, so
 *      an all-digit code contributes its unpadded form plus each padded
 *      width that is at least as long as the unpadded digits.
 */
import { parseGs1 } from "./parseGs1";

/** GTIN widths recognised by GS1. Ascending — padding never truncates. */
export const GTIN_WIDTHS = [8, 12, 13, 14] as const;

/** `code_norm` for any raw code. Mirrors SQL `upper(btrim(code))`. */
export function normalizeIdentityCode(raw: string): string {
  return (raw ?? "").trim().toUpperCase();
}

/** Extract the AI (01) GTIN from a GS1 payload, else null. */
export function gs1GtinOf(raw: string): string | null {
  const parsed = parseGs1((raw ?? "").trim());
  if (!parsed.ok) return null;
  return parsed.normalized.gtin ?? null;
}

/**
 * Every code that may legitimately match the scanned payload, most
 * specific first. Callers match `code_norm = ANY(candidates)`.
 */
export function identityCodeCandidates(raw: string): string[] {
  const norm = normalizeIdentityCode(raw);
  if (!norm) return [];

  const out: string[] = [norm];
  const push = (c: string) => {
    if (c && !out.includes(c)) out.push(c);
  };

  // (2) GS1 element string → its GTIN.
  const gtin = gs1GtinOf(raw);
  if (gtin) push(gtin);

  // (3) GTIN padding family — for the raw code when it is all digits AND
  // for the GS1 GTIN, so `0105012345678900` still reaches `5012345678900`.
  for (const digits of [norm, gtin ?? ""]) {
    if (!/^[0-9]{8,14}$/.test(digits)) continue;
    const stripped = digits.replace(/^0+/, "") || "0";
    push(stripped);
    for (const w of GTIN_WIDTHS) {
      if (stripped.length <= w) push(stripped.padStart(w, "0"));
    }
  }

  return out;
}

/**
 * Is an identifier row live right now? Mirrors the SQL predicate
 * `status = 'active' AND valid_from <= now() AND valid_to > now()`.
 * Used by the offline matcher so a retired code cannot resolve on a
 * terminal that has lost connectivity.
 */
export function isIdentifierLive(
  row: { status?: string | null; valid_from?: string | null; valid_to?: string | null },
  now: Date = new Date(),
): boolean {
  const status = (row.status ?? "active").toLowerCase();
  if (status !== "active") return false;
  if (row.valid_from && new Date(row.valid_from).getTime() > now.getTime()) return false;
  if (row.valid_to && new Date(row.valid_to).getTime() <= now.getTime()) return false;
  return true;
}
