import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture guard — the statutory e-filing dispatcher must remain
 * metadata-driven. Per-country branches (KRA, URA, SARS, etc.) inside the
 * Edge Function would break the country-agnostic publishing contract from
 * the audit plan (Slice G). New authorities are onboarded via pack metadata
 * (api_endpoint_spec / digital_signature_spec / acknowledgement_spec), not
 * via if/else in the dispatcher.
 *
 * If you legitimately need a country-specific quirk, encode it as a new
 * spec field consumed generically, and update this guard's allowlist.
 */
describe("statutory dispatcher stays metadata-driven", () => {
  const path = join(process.cwd(), "supabase/functions/submit-statutory-return/index.ts");

  it("dispatcher source exists", () => {
    expect(existsSync(path)).toBe(true);
  });

  it("contains no per-country branches", () => {
    if (!existsSync(path)) return;
    const src = readFileSync(path, "utf8");
    // Strip comments before scanning so doc strings can mention these names.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/^\s*\*.*$/gm, "");
    const banned = ["KRA", "iTax", "URA", "SARS", "eFiling", "TRA", "ELSTAM", "ZIMRA"];
    for (const term of banned) {
      const re = new RegExp(`\\b${term}\\b`, "i");
      expect(re.test(stripped), `${term} appears in dispatcher source`).toBe(false);
    }
  });
});
