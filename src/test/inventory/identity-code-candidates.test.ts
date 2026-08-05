/**
 * ADR-0110 Phase 6 — one grammar, one matcher.
 *
 * Proves the TS candidate generator against the shared vectors. The SQL
 * mirror is proven against the SAME vectors in
 * `supabase/tests/identity_code_candidates_test.sql`.
 */
import { describe, it, expect } from "vitest";
import {
  identityCodeCandidates,
  normalizeIdentityCode,
  isIdentifierLive,
} from "@/lib/gs1/identityCodes";
import { IDENTITY_CODE_VECTORS } from "@/lib/gs1/identityCodeVectors";

describe("identityCodeCandidates — shared vectors", () => {
  for (const v of IDENTITY_CODE_VECTORS) {
    it(`${JSON.stringify(v.raw)} → ${v.why}`, () => {
      expect(identityCodeCandidates(v.raw)).toEqual(v.candidates);
    });
  }

  it("normalisation is upper(btrim), never lower()", () => {
    expect(normalizeIdentityCode(" lmn-500 ")).toBe("LMN-500");
  });

  it("candidates never contain duplicates", () => {
    for (const v of IDENTITY_CODE_VECTORS) {
      const c = identityCodeCandidates(v.raw);
      expect(new Set(c).size).toBe(c.length);
    }
  });
});

describe("isIdentifierLive — offline lifecycle parity", () => {
  const now = new Date("2026-08-06T00:00:00Z");

  it("accepts an active, currently valid identifier", () => {
    expect(isIdentifierLive({ status: "active", valid_from: "2026-01-01T00:00:00Z" }, now)).toBe(true);
  });

  it("rejects retired/archived statuses", () => {
    expect(isIdentifierLive({ status: "retired" }, now)).toBe(false);
    expect(isIdentifierLive({ status: "archived" }, now)).toBe(false);
  });

  it("rejects a not-yet-valid identifier", () => {
    expect(isIdentifierLive({ status: "active", valid_from: "2026-09-01T00:00:00Z" }, now)).toBe(false);
  });

  it("rejects an expired identifier", () => {
    expect(isIdentifierLive({ status: "active", valid_to: "2026-07-01T00:00:00Z" }, now)).toBe(false);
  });
});
