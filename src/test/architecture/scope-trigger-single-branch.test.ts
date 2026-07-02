/**
 * Architecture guard — Round-5.
 *
 * Ensures `useCanSwitchScope.canSwitchToConsolidated` keeps the
 * `branches.length >= 2` threshold. A regression to `>= 1` would
 * re-introduce the "Change scope" button on single-branch tenants
 * (no-op switcher), contradicting Odoo / NetSuite / Dynamics /
 * QuickBooks Enterprise behavior.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("useCanSwitchScope consolidated threshold", () => {
  const src = readFileSync(
    join(process.cwd(), "src/hooks/useCanSwitchScope.ts"),
    "utf8",
  );

  it("requires ≥ 2 branches for canSwitchToConsolidated", () => {
    expect(src).toMatch(
      /canSwitchToConsolidated\s*=\s*[\s\S]*?branches\.length\s*>=\s*2/,
    );
  });

  it("never allows the legacy `>= 1` threshold", () => {
    expect(src).not.toMatch(
      /canSwitchToConsolidated[\s\S]*?branches\.length\s*>=\s*1[^\d]/,
    );
  });
});
