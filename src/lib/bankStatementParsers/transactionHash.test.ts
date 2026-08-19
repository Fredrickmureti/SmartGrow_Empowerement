import { describe, it, expect } from "vitest";
import { generateTransactionHash } from "./index";

/**
 * The browser hash and the database function
 * `public.bank_transaction_fingerprint` must agree: the preview duplicate
 * count is computed client-side while the stored `external_transaction_id`
 * is computed server-side. If the two drift, the wizard reports a duplicate
 * count that has nothing to do with what the import actually skips.
 *
 * The pinned vector below is asserted identically in
 * supabase/tests/bank_transaction_fingerprint_overflow_test.sql.
 */
const ACCOUNT = "cf817a72-e0e6-43ff-b6e0-e080db9acaaf";

describe("generateTransactionHash", () => {
  it("matches the fingerprint vector pinned in the database test", () => {
    expect(
      generateTransactionHash(
        "2026-01-15",
        "ACME SUPPLIES LTD PAYMENT REF 99321 BRANCH WESTLANDS",
        15234.75,
        "REF-889231",
        ACCOUNT,
      ),
    ).toBe("imp_aa29bd90a544fc70");
  });

  it("always produces the imp_ + 16 hex-digit shape", () => {
    const vectors: Array<[string, number, string]> = [
      ["", 0, ""],
      ["X".repeat(4000), -1, "R"],
      ["Café Zürich — naïve payée", 12.34, "ÄÖÜ"],
      ["emoji 😀 in description", -999999.99, "😀"],
      ["MPESA/QR/12345678901234567890/PAY BILL", 1, "QR"],
    ];

    for (const [description, amount, reference] of vectors) {
      expect(
        generateTransactionHash("2026-01-15", description, amount, reference, ACCOUNT),
      ).toMatch(/^imp_[0-9a-f]{16}$/);
    }
  });

  it("is deterministic and sensitive to every input", () => {
    const base = generateTransactionHash("2026-01-15", "Repeat me", -50.5, "R1", ACCOUNT);
    expect(generateTransactionHash("2026-01-15", "Repeat me", -50.5, "R1", ACCOUNT)).toBe(base);

    expect(generateTransactionHash("2026-01-16", "Repeat me", -50.5, "R1", ACCOUNT)).not.toBe(base);
    expect(generateTransactionHash("2026-01-15", "Repeat me!", -50.5, "R1", ACCOUNT)).not.toBe(base);
    expect(generateTransactionHash("2026-01-15", "Repeat me", 50.5, "R1", ACCOUNT)).not.toBe(base);
    expect(generateTransactionHash("2026-01-15", "Repeat me", -50.5, "R2", ACCOUNT)).not.toBe(base);
    expect(
      generateTransactionHash("2026-01-15", "Repeat me", -50.5, "R1", "00000000-0000-0000-0000-000000000000"),
    ).not.toBe(base);
  });
});
