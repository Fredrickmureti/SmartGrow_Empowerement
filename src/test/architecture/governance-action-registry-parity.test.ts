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

/** Extract action_key literals out of every registry seed INSERT block. */
function seededRegistryKeys(): string[] {
  const dir = join(process.cwd(), "supabase", "migrations");
  const keys = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, f), "utf8");
    const blocks = sql.matchAll(
      /INSERT\s+INTO\s+public\.governance_action_registry[\s\S]*?;/gi
    );
    for (const block of blocks) {
      for (const m of block[0].matchAll(/'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'/g)) {
        keys.add(m[1]);
      }
    }
  }
  return Array.from(keys);
}

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

  it("the per-action overrides screen is driven by the DB registry, not the static catalogue", () => {
    // Registry rows with no catalogue entry (Warehouse, Purchasing reversal
    // keys, …) must still be configurable. The screen therefore reads the
    // registry; the catalogue only supplies entity metadata for overrides.
    const screen = readFileSync(
      join(process.cwd(), "src/components/settings/SelfActionPolicy.tsx"),
      "utf8"
    );
    expect(screen).toMatch(/useGovernanceActionRegistry\(/);
    // The grouping must consume the registry result.
    expect(screen).toMatch(/for \(const r of registry\)/);
  });

  it("every seeded registry key is either in the catalogue or reachable via the registry-driven screen", () => {
    const known = new Set(SELF_ACTION_CATALOGUE.map((e) => e.key));
    const seeded = seededRegistryKeys();
    expect(seeded.length).toBeGreaterThan(0);
    // Warehouse is the module this wave added — it must be in both.
    expect(seeded).toContain("warehouse.count_variance");
    expect(known.has("warehouse.count_variance")).toBe(true);
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
