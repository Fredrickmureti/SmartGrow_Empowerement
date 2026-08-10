/**
 * Phase 1 architecture guard — Approval & Governance Consolidation.
 *
 * The static `SELF_ACTION_CATALOGUE` in
 * `src/lib/governance/selfActionCatalogue.ts` must stay in exact parity with
 * the seed of the canonical `public.governance_action_registry` table
 * (introduced by the Phase 1 migration). Both are compile-time mirrors of the
 * same truth: the code catalogue is what triggers/hooks import today, and the
 * DB table is what future FKs on `approval_rules.action_name` and the
 * `approval_route` / `approval_decide` RPCs will validate against.
 *
 * Any drift here means either the code has invented an action key the engine
 * cannot route, or a new engine-known action has no UI-side entry. Both are
 * blocking violations of the "single registry" principle.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SELF_ACTION_CATALOGUE } from "@/lib/governance/selfActionCatalogue";

function readRegistryMigrations(): string {
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

describe("Approval & Governance — action registry parity (Phase 1)", () => {
  const migrationSql = readRegistryMigrations();

  it("every SELF_ACTION_CATALOGUE key is seeded into governance_action_registry", () => {
    const missing = SELF_ACTION_CATALOGUE.filter(
      (entry) => !migrationSql.includes(`'${entry.key}'`)
    ).map((e) => e.key);
    expect(missing, `missing seed rows: ${missing.join(", ")}`).toEqual([]);
  });

  it("registry seed carries the CHECK constraint for subject_mode", () => {
    expect(migrationSql).toMatch(
      /subject_mode\s+text\s+NOT NULL\s+CHECK\s*\(\s*subject_mode\s+IN\s*\(\s*'actor'\s*,\s*'from_entity'\s*\)\s*\)/i
    );
  });

  it("registry is RLS-enabled and platform-admin write-gated", () => {
    expect(migrationSql).toMatch(
      /ALTER TABLE public\.governance_action_registry ENABLE ROW LEVEL SECURITY/
    );
    expect(migrationSql).toMatch(/is_platform_admin\(auth\.uid\(\)\)/);
  });

  it("approval_rules gains the registry-check trigger", () => {
    expect(migrationSql).toMatch(/trg_approval_rules_registry_check/);
  });

  it("subject_mode values in code match the registry CHECK constraint", () => {
    const allowed = new Set(["actor", "from_entity"]);
    const bad = SELF_ACTION_CATALOGUE.filter((e) => !allowed.has(e.subjectMode));
    expect(bad).toEqual([]);
  });
});
