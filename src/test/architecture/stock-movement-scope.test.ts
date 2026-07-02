/**
 * Architecture guard — Phase G.
 *
 * Every direct insert into `stock_movements` from application code must
 * carry both `business_id` AND `warehouse_id`. The DB trigger
 * `enforce_stock_movement_branch_scope` derives `branch_id` from the
 * warehouse, but it CANNOT derive `business_id` for us — a NULL business
 * stamps a row that escapes every business-scoped report filter.
 *
 * The audit (3.3, 3.4, 3.5) found three separate paths that wrote movements
 * without one or both of these fields. The fixes are landed in Phase A.
 * This test prevents regression.
 *
 * Allowed exceptions: server-side SQL functions/RPCs (they read the schema
 * directly), and migration tooling that runs before scope is established.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCOPES = ["src/hooks", "src/pages", "src/components", "src/services"];

const ALLOWLIST = new Set<string>([
  // Migration import path: rows pre-date branch context.
  "src/components/migration/steps/MigrationStepInventory.tsx",
  // The architecture test files themselves contain example strings.
  "src/test/architecture/stock-movement-scope.test.ts",
  "src/test/architecture/inventory-branch-filter.test.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Find every `.from("stock_movements") … .insert(<obj>)` (or chained insert)
 * and verify the inserted object literal mentions both business_id and
 * warehouse_id. We use a windowed match on the source between the `.from(
 * "stock_movements")` call and the matching `.insert(...)`.
 */
function findOffenders(): { file: string; reason: string }[] {
  const offenders: { file: string; reason: string }[] = [];
  const FROM_RE = /\.from\(\s*["']stock_movements["']\s*\)/g;

  for (const scope of SCOPES) {
    for (const file of walk(scope)) {
      const rel = file.replace(/\\/g, "/");
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      let match: RegExpExecArray | null;
      FROM_RE.lastIndex = 0;
      while ((match = FROM_RE.exec(src))) {
        // Look ahead ~1500 chars for an .insert(...) call. If we find it,
        // verify business_id and warehouse_id appear in that window.
        const window = src.slice(match.index, match.index + 1500);
        const insertIdx = window.search(/\.insert\s*\(/);
        if (insertIdx === -1) continue;
        // Take the next 800 chars as the insert payload region.
        const payload = window.slice(insertIdx, insertIdx + 800);
        const hasBiz = /business_id\s*:/.test(payload);
        const hasWh = /warehouse_id\s*:/.test(payload);
        if (!hasBiz || !hasWh) {
          offenders.push({
            file: rel,
            reason: `stock_movements insert missing ${
              [!hasBiz && "business_id", !hasWh && "warehouse_id"]
                .filter(Boolean)
                .join(" + ")
            }`,
          });
        }
      }
    }
  }
  return offenders;
}

describe("stock_movements inserts must carry business_id + warehouse_id", () => {
  it("no client code inserts a movement without scope keys", () => {
    const offenders = findOffenders();
    expect(
      offenders,
      `These insert paths bypass company/warehouse attribution. Add ` +
        `business_id and warehouse_id to the payload, or — if intentionally ` +
        `pre-scope (e.g. migration) — add the file to the ALLOWLIST in ` +
        `this test with a justification.\n\nOffenders:\n` +
        offenders.map((o) => `  - ${o.file}: ${o.reason}`).join("\n"),
    ).toEqual([]);
  });
});
