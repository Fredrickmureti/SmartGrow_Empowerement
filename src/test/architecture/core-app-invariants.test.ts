/**
 * Architecture invariant: core platform apps cannot be deactivated or
 * deleted from `organization_installed_apps`. The latest migration must
 * define `enforce_core_app_active_tg` referencing `platform_apps.is_core`
 * and install a BEFORE UPDATE OR DELETE trigger on
 * `organization_installed_apps`. See `.lovable/plan.md` Phase 5.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "glob";

const MIGRATIONS_ROOT = join(process.cwd(), "supabase", "migrations");

describe("core app install invariants", () => {
  const files = globSync("*.sql", { cwd: MIGRATIONS_ROOT, absolute: true }).sort();
  const all = files.map((f) => readFileSync(f, "utf8")).join("\n");

  it("defines enforce_core_app_active_tg and references platform_apps.is_core", () => {
    const fnIdx = all.lastIndexOf("enforce_core_app_active_tg");
    expect(fnIdx, "enforce_core_app_active_tg must exist in migrations").toBeGreaterThan(-1);

    const body = all.slice(fnIdx, fnIdx + 4000);
    expect(body).toMatch(/platform_apps/i);
    expect(body).toMatch(/is_core/i);
  });

  it("installs the BEFORE UPDATE OR DELETE trigger on organization_installed_apps", () => {
    expect(all).toMatch(/CREATE TRIGGER\s+trg_enforce_core_app_active/i);
    const trgIdx = all.lastIndexOf("trg_enforce_core_app_active");
    const trgBlock = all.slice(trgIdx, trgIdx + 600);
    expect(trgBlock).toMatch(/BEFORE\s+UPDATE\s+OR\s+DELETE/i);
    expect(trgBlock).toMatch(/organization_installed_apps/i);
  });

  it("no migration sets is_active=false on a core-app row by app_id", () => {
    // Negative guard: no UPDATE … SET is_active = false … WHERE app_id IN (... is_core …)
    const re =
      /UPDATE\s+[\w.]*organization_installed_apps[\s\S]{0,400}is_active\s*=\s*false[\s\S]{0,400}is_core\s*=\s*true/gi;
    const offenders = all.match(re) ?? [];
    expect(
      offenders,
      `Found migration(s) flipping is_active=false for core apps:\n${offenders.join("\n---\n")}`,
    ).toEqual([]);
  });
});
