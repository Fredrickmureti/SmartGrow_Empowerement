import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * M9 — pack upgrade must propagate ADD-only changes for tax_rates and
 * accounts in addition to payroll_statutory_rules. Asserts the latest
 * `_apply_pack_upgrade_atomic_unchecked` body references both snapshot
 * keys so a future refactor cannot silently drop coverage.
 */
describe("pack upgrade — broader diff coverage", () => {
  it("apply RPC propagates tax_rates and accounts from the snapshot", () => {
    const dir = "supabase/migrations";
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const hits = files
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .filter((s) =>
        s.includes("_apply_pack_upgrade_atomic_unchecked") &&
        s.includes("CREATE OR REPLACE FUNCTION"),
      );
    expect(hits.length).toBeGreaterThan(0);
    const latest = hits[hits.length - 1];
    expect(latest).toContain("localization_pack_tax_templates");
    expect(latest).toContain("localization_pack_account_templates");
    expect(latest).toMatch(/INTO public\.tax_rates/);
    expect(latest).toMatch(/INTO public\.accounts/);
  });
});