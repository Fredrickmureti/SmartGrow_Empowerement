/**
 * Guard: no seed migration may ever insert a garnishment policy percentage in
 * percent form (>1). The payroll engine multiplies these values directly
 * against gross/disposable — a percent-form seed silently zeros every
 * legal-order deduction (see docs/audit — Kenya-pack fraction regression).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

describe("garnishment policy pct columns are stored in fraction form", () => {
  it("no migration inserts aggregate_cap_pct or min_take_home_pct > 1", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const offenders: string[] = [];

    // Match numeric literals in the neighbourhood of the two columns.
    const columnHint = /(aggregate_cap_pct|min_take_home_pct|garnishment_aggregate_cap_pct|garnishment_minimum_take_home_pct)/i;

    for (const file of files) {
      const body = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (!columnHint.test(body)) continue;
      // Look for VALUES / SET lines pairing the column with a numeric literal > 1
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const window = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
        if (!columnHint.test(window)) continue;
        // Any bare numeric literal in the window that is > 1 and <= 100 is suspect
        const matches = lines[i].match(/(?<![\w.])(\d+\.\d+)(?![\w.])/g);
        if (!matches) continue;
        for (const m of matches) {
          const n = Number(m);
          if (n > 1 && n <= 100) {
            offenders.push(`${file}:${i + 1}  ${lines[i].trim()}`);
            break;
          }
        }
      }
    }

    expect(
      offenders,
      `Found garnishment policy pct literal(s) in percent form (>1). Store as fraction (0..1):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
