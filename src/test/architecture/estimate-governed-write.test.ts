import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "glob";

/**
 * Phase 9 — estimate lines are a governed, transactional write.
 *
 * `trg_00_estimate_items_governed_write` / `trg_00_estimate_costs_governed_write`
 * reject any DML on `estimate_items` / `estimate_additional_costs` that does not
 * originate from `create_estimate_atomic`, `update_estimate_atomic` or the
 * conversion RPCs. A browser delete-then-insert now throws at runtime, so this
 * guard catches it at build time instead.
 */
describe("estimate governed write", () => {
  const files = globSync("src/**/*.{ts,tsx}", {
    ignore: ["src/test/**", "src/integrations/supabase/types.ts"],
  });

  const LINE_TABLES = ["estimate_items", "estimate_additional_costs"];

  it("no client-side insert/update/delete of estimate lines or costs", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const table of LINE_TABLES) {
        const re = new RegExp(
          `\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)\\s*\\n?\\s*\\.(insert|update|upsert|delete)\\b`,
          "g",
        );
        if (re.test(src)) offenders.push(`${file} → ${table}`);
      }
    }
    expect(
      offenders,
      `Direct estimate line DML (use create_estimate_atomic / update_estimate_atomic): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("no client-side insert of estimate headers", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/\.from\(\s*["'`]estimates["'`]\s*\)\s*\n?\s*\.insert\b/.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      `Direct estimates insert (use create_estimate_atomic): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the writer seam calls the atomic RPCs with an idempotency key", () => {
    const seam = readFileSync("src/hooks/estimates/estimateWriter.ts", "utf8");
    expect(seam).toContain("create_estimate_atomic");
    expect(seam).toContain("update_estimate_atomic");
    expect(seam).toContain("p_idempotency_key");
  });

  it("estimate writes go through the seam, not raw rpc calls", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith("src/hooks/estimates/estimateWriter.ts")) continue;
      const src = readFileSync(file, "utf8");
      if (/rpc\(\s*["'`](create|update)_estimate_atomic/.test(src)) offenders.push(file);
    }
    expect(offenders, `Raw estimate RPC call outside the seam: ${offenders.join(", ")}`).toEqual([]);
  });
});
