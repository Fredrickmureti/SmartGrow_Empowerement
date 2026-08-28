/**
 * R4 — the residual policy has to be honest.
 *
 * Two failures were live before this: a tolerance fitted to the observed
 * residual (41,500 KES) made a real KES 40,000 disagreement look immaterial,
 * and the engine routed anything "within tolerance" to the translation reserve
 * regardless of the group's chosen difference policy — so a group set to
 * `refuse` never refused.
 *
 * These assertions read the latest definition of the engine and the rule guard
 * out of the migration history, so a later migration that reintroduces either
 * behaviour fails here rather than in a set of published statements.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/** Newest migration text that redefines the given database object. */
function latestDefinitionOf(marker: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (sql.includes(marker)) return sql;
  }
  throw new Error(`No migration defines ${marker}`);
}

const engine = latestDefinitionOf(
  "FUNCTION public.consolidation_generate_eliminations",
);
const guard = latestDefinitionOf(
  "FUNCTION public._consolidation_elimination_rule_guard",
);

describe("elimination engine — difference handling", () => {
  it("refuses when the group's policy is refuse, inside tolerance included", () => {
    expect(engine).toContain("IF v_policy = 'refuse' THEN");
    expect(engine).toContain("a refusing group refuses regardless");
  });

  it("never routes a difference to the reserve on tolerance alone", () => {
    expect(engine).not.toContain("rounding_within_tolerance_posted_to_cta");
    expect(engine).not.toContain("rounding_within_tolerance_posted_to_difference");
    // Reaching the reserve requires the group to have chosen it.
    const ctaPost = engine.indexOf("translation_residual_posted_to_cta");
    const policyGate = engine.indexOf("IF v_policy = 'post_to_cta' THEN");
    expect(policyGate).toBeGreaterThan(-1);
    expect(ctaPost).toBeGreaterThan(policyGate);
  });

  it("keeps a trading mismatch out of the translation reserve", () => {
    expect(engine).toContain("IF v_class = 'intercompany_trading' THEN");
    expect(engine).toContain(
      "unrecorded revenue, unrealised profit or a cut-off difference",
    );
  });

  it("records whether a posted difference was inside the tolerance", () => {
    expect(engine).toContain("'within_tolerance', v_within_tolerance");
  });
});

describe("tolerance configuration", () => {
  it("is bounded to rounding scale", () => {
    expect(guard).toContain("public.consolidation_tolerance_cap()");
    expect(guard).toContain("is larger than the rounding bound");
  });

  it("requires a written reason above zero and attributes the change", () => {
    expect(guard).toContain("NEW.tolerance_amount > 0");
    expect(guard).toContain("NEW.tolerance_set_by");
    expect(guard).toContain("consolidation_group_change_log");
  });

  it("refuses a trading rule that names the translation reserve", () => {
    expect(guard).toContain(
      "NEW.elimination_class = 'intercompany_trading' AND NEW.difference_policy = 'post_to_cta'",
    );
  });
});
