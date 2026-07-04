/**
 * Architecture guard — post-payroll-gl resolves GL accounts through the
 * effective-dated binding resolver.
 *
 * Phase 5 made `default_account_setting_bindings` +
 * `resolve_default_account_binding` load-bearing: posting must resolve each
 * mapping key through the temporal/branch-cascading resolver (using the run's
 * pay-period end as `as_of`) so a re-post of a historical run uses the account
 * that was mapped *then*, not today's. A prior implementation populated the
 * binding table but never read it, silently reverting posting to the flat
 * table. This guard fails if that regression returns.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "supabase", "functions", "post-payroll-gl", "index.ts"),
  "utf8",
);

describe("post-payroll-gl — effective-dated binding resolution", () => {
  it("invokes resolve_default_account_binding", () => {
    expect(SRC).toMatch(/rpc\(\s*["']resolve_default_account_binding["']/);
  });

  it("passes the run's pay-period end as the as_of instant (not now())", () => {
    // The resolution must be anchored to the run period, otherwise historical
    // re-posts drift to the current mapping.
    expect(SRC).toMatch(/pay_period_end/);
    const idx = SRC.search(/rpc\(\s*["']resolve_default_account_binding["']/);
    const window = SRC.slice(Math.max(0, idx - 800), idx + 400);
    expect(window).toMatch(/_as_of/);
  });

  it("passes the run's branch for the branch → business → org cascade", () => {
    const idx = SRC.search(/rpc\(\s*["']resolve_default_account_binding["']/);
    const window = SRC.slice(Math.max(0, idx - 400), idx + 400);
    expect(window).toMatch(/_branch_id/);
  });

  it("keeps the flat default_account_settings map only as a fallback", () => {
    // resolveAccount prefers the binding map, then falls back to the flat map.
    expect(SRC).toMatch(/bindingMap\[key\]\s*\|\|\s*mappingsMap\[key\]/);
  });
});
