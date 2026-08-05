/**
 * Shared identity-code vectors (ADR-0110, Phase 6).
 *
 * These vectors are the contract between the three matchers:
 *   - TS   `identityCodeCandidates`      (src/lib/gs1/identityCodes.ts)
 *   - SQL  `identity_code_candidates`    (migration 20260806000000)
 *   - offline SQLite matcher             (SQLiteBridge)
 *
 * `supabase/tests/identity_code_candidates_test.sql` carries the SAME
 * list. If you add a vector here, add it there in the same change.
 */
export interface IdentityCodeVector {
  /** Raw scanned payload. */
  raw: string;
  /** Expected candidates, in order, most specific first. */
  candidates: string[];
  why: string;
}

export const IDENTITY_CODE_VECTORS: IdentityCodeVector[] = [
  {
    raw: "  5901234123457  ",
    candidates: ["5901234123457", "05901234123457"],
    why: "EAN-13: trimmed, plus the GTIN-14 padded form",
  },
  {
    raw: "05012345678900",
    candidates: ["05012345678900", "5012345678900"],
    why: "GTIN-14 with a leading zero also matches the EAN-13 it wraps",
  },
  {
    raw: "012345678905",
    candidates: ["012345678905", "12345678905", "0012345678905", "00012345678905"],
    why: "UPC-12: unpadded plus 13/14 padded forms",
  },
  {
    raw: "12345670",
    candidates: ["12345670", "000012345670", "0000012345670", "00000012345670"],
    why: "GTIN-8 pads up to 12/13/14",
  },
  {
    raw: "0105012345678900\u001d10LOT42",
    candidates: ["0105012345678900\u001D10LOT42", "05012345678900", "5012345678900"],
    why: "GS1 element string contributes its AI (01) GTIN and that GTIN's padding family",
  },
  {
    raw: "abc-123",
    candidates: ["ABC-123"],
    why: "non-numeric SKU: upper-cased only, never lower-cased",
  },
  {
    raw: "   ",
    candidates: [],
    why: "blank input resolves to no candidates at all",
  },
];
