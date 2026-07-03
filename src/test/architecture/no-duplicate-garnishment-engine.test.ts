/**
 * Guard test — the client garnishment-engine module MUST remain a thin
 * re-export of the canonical Deno-shared implementation.
 *
 * Phase 2 dedup made `src/lib/payroll/garnishment-engine.ts` a re-export
 * shim over `supabase/functions/_shared/garnishment-engine.ts`. If a
 * future edit re-introduces local logic (functions, arithmetic, state
 * machines) in the client file, the two engines will silently drift and
 * client-side simulators will disagree with the production payroll run.
 *
 * This test fails the build in that case.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const shimPath = join(process.cwd(), "src/lib/payroll/garnishment-engine.ts");
const shim = readFileSync(shimPath, "utf8");

describe("garnishment-engine client shim", () => {
  it("re-exports from the shared Deno module", () => {
    expect(shim).toMatch(
      /from\s+["'](?:\.\.\/){3}supabase\/functions\/_shared\/garnishment-engine["']/,
    );
  });

  it("does not declare local runtime logic", () => {
    // Strip block/line comments so the prose in the file header doesn't
    // trip these greps.
    const code = shim
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // No function declarations, arrow functions, or class bodies allowed
    // — everything must come through the re-export.
    expect(code).not.toMatch(/\bfunction\s+\w+\s*\(/);
    expect(code).not.toMatch(/=>\s*\{/);
    expect(code).not.toMatch(/\bclass\s+\w+/);
  });
});
