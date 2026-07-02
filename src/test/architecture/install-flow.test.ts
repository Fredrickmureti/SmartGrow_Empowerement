/**
 * Architecture invariants for the app installation flow.
 *
 * 1. `start_app_trial` must NOT be called from anywhere in the frontend.
 *    Trials are an internal side effect of `install_app` — calling
 *    `start_app_trial` directly produces orphan trials when the install
 *    fails partway, which is the original bug class this enforces.
 *
 * 2. Every install button must funnel through `useInstalledApps.installApp`,
 *    not raw `supabase.rpc("install_app", …)`, so error mapping and cache
 *    invalidation stay consistent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { globSync } from "glob";

const ROOT = join(process.cwd(), "src");
const MIGRATIONS_ROOT = join(process.cwd(), "supabase", "migrations");

const ALL_TS = globSync("**/*.{ts,tsx}", {
  cwd: ROOT,
  absolute: true,
  ignore: [
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/__tests__/**",
    "test/**",
    "test/architecture/**",
  ],
});

describe("install flow architecture", () => {
  it("keeps install attempt outcomes aligned with install_app pending state", () => {
    const migrationFiles = globSync("*.sql", {
      cwd: MIGRATIONS_ROOT,
      absolute: true,
    }).sort();

    const migrations = migrationFiles.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(migrations).toMatch(/INSERT\s+INTO\s+public\.app_install_attempts[\s\S]*?VALUES[\s\S]*?['"]pending['"]/i);

    const latestConstraintIndex = migrations.lastIndexOf("app_install_attempts_outcome_check");
    expect(latestConstraintIndex).toBeGreaterThan(-1);
    const latestConstraintBlock = migrations.slice(latestConstraintIndex, latestConstraintIndex + 700);

    for (const outcome of ["pending", "success", "blocked", "error"]) {
      expect(latestConstraintBlock).toContain(outcome);
    }
  });

  it("never invokes start_app_trial from the client", () => {
    const offenders: string[] = [];
    for (const file of ALL_TS) {
      const src = readFileSync(file, "utf8");
      // Match supabase.rpc("start_app_trial", …) or .rpc('start_app_trial', …)
      if (/\.rpc\(\s*["']start_app_trial["']/.test(src)) {
        offenders.push(relative(process.cwd(), file));
      }
    }
    expect(
      offenders,
      `start_app_trial is internal — call install_app instead. Offenders:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("only useInstalledApps.ts calls install_app via supabase.rpc", () => {
    const offenders: string[] = [];
    for (const file of ALL_TS) {
      const src = readFileSync(file, "utf8");
      if (!/\.rpc\(\s*["']install_app["']/.test(src)) continue;
      const rel = relative(process.cwd(), file).replace(/\\/g, "/");
      if (rel.endsWith("src/hooks/useInstalledApps.ts")) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      `install_app must be called via useInstalledApps.installApp(). Offenders:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
