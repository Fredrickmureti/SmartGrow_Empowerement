/**
 * Phase 3 guard (document convergence, 2026-08-06).
 *
 * `generate-document` still owns the legacy live-read `fetchX` projections
 * for document kinds that have not been onboarded onto the document model.
 * It must NOT, however, use those projections when a frozen snapshot exists:
 * the canonical artifact (or a render of the frozen snapshot) always wins,
 * so print / preview / email / export / archive agree byte-for-byte.
 *
 * This test pins:
 *   1. the short-circuit exists and calls the shared resolver,
 *   2. it runs AFTER tenancy (org membership) and entitlement gating —
 *      the Wave 11 ZPL lesson: no branch may return bytes before the gates,
 *   3. it only claims PDF output (escpos / zpl / csv keep their branches),
 *   4. the legacy fallback is preserved (no hard failure when no record).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(__dirname, "../../../supabase/functions/generate-document/index.ts"),
  "utf-8",
);

const idx = (needle: string) => {
  const i = SRC.indexOf(needle);
  expect(i, `expected to find: ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe("generate-document is snapshot-first", () => {
  it("resolves the canonical PDF through the shared resolver", () => {
    expect(SRC).toContain("_shared/documents/canonicalPdf.ts");
    expect(SRC).toContain("resolveCanonicalPdf({");
  });

  it("short-circuits only for PDF output", () => {
    expect(SRC).toContain("const wantsCanonicalPdf =");
    expect(SRC).toMatch(/wantsCanonicalPdf\s*=\s*\n?\s*\(!format \|\| format === "pdf"\)/);
  });

  it("runs after org-membership and entitlement gating", () => {
    const membership = idx('.from("user_roles")');
    const entitlement = idx("return entDenied(subResult, corsHeaders);");
    const shortCircuit = idx("resolveCanonicalPdf({");
    expect(shortCircuit).toBeGreaterThan(membership);
    expect(shortCircuit).toBeGreaterThan(entitlement);
  });

  it("keeps the legacy projection as a non-fatal fallback", () => {
    expect(SRC).toContain("[canonical] falling back to legacy projection");
    // The legacy fetchers must still be reachable for kinds without builders.
    expect(SRC).toContain("const fetcher = FETCHER_MAP[documentType];");
  });
});
