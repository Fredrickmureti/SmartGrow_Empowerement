/**
 * ADR-0149 guards.
 *
 * 1. `bank_unmatch_preflight` has exactly one client caller — the seam.
 * 2. The residual remedy table stays navigation-and-wording only: it must not
 *    call supabase, do arithmetic on amounts, or mutate anything.
 * 3. The explainer keeps deriving its remedies from that table rather than
 *    hard-coding advice per finding.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("un-match pre-flight (ADR-0149)", () => {
  it("is called through the single client seam", () => {
    const callers = walk(join(root, "src"))
      .filter((f) => !f.includes(`${"src"}/test/`))
      .filter((f) => readFileSync(f, "utf8").includes('"bank_unmatch_preflight"'));

    expect(callers.map((f) => f.replace(`${root}/`, ""))).toEqual([
      "src/services/finance/bankUnmatchPreflight.ts",
    ]);
  });

  it("never treats a failed check as permission to proceed", () => {
    const page = readFileSync(join(root, "src/pages/BankReconciliation.tsx"), "utf8");
    // The confirm button is disabled while checking and when refused.
    expect(page).toContain("unmatchPreflight?.allowed === false");
    expect(page).toContain("preflightLoading");
  });
});

describe("residual remedies stay advice, not accounting", () => {
  const remedies = readFileSync(
    join(root, "src/features/finance/reconciliation/residualRemedies.ts"),
    "utf8",
  );

  it("does not reach the database", () => {
    expect(remedies).not.toMatch(/supabase/i);
  });

  it("does no arithmetic on reported figures", () => {
    expect(remedies).not.toMatch(/toFixed|Math\.abs|[+\-*/]=\s*\w+\.amount/);
  });

  it("covers every code the engine can emit", () => {
    for (const code of [
      "duplicate_opening_balance",
      "unmatched_equal_pairs",
      "sign_flipped_pairs",
      "cleared_without_posting",
      "single_item_equals_residual",
      "fx_fallback_lines",
    ]) {
      expect(remedies).toContain(`${code}:`);
    }
  });

  it("is the explainer's only source of remedy wording", () => {
    const explainer = readFileSync(
      join(root, "src/components/reports/ResidualExplainer.tsx"),
      "utf8",
    );
    expect(explainer).toContain("resolveRemedy");
    expect(explainer).not.toContain("duplicate_opening_balance");
  });
});
