/**
 * Architecture guard — Inventory.
 *
 * Every direct insert into `stock_adjustments` from application code must
 * carry `warehouse_id` AND `business_id`. The DB column is NOT NULL and the
 * branch trigger derives `branch_id` from the warehouse — but it cannot fix
 * a missing warehouse_id, which manifests as the user-visible 23502 error
 * "null value in column \"warehouse_id\" of relation \"stock_adjustments\""
 * that previously hit the Inventory page on every create.
 *
 * Allowed exceptions: server-side SQL (RPCs read the schema directly) and
 * the architecture tests themselves which contain example strings.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCOPES = ["src/hooks", "src/pages", "src/components", "src/services"];

const ALLOWLIST = new Set<string>([
  "src/test/architecture/stock-adjustment-warehouse-stamp.test.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function findOffenders(): { file: string; reason: string }[] {
  const offenders: { file: string; reason: string }[] = [];
  const FROM_RE = /\.from\(\s*["']stock_adjustments["']\s*\)/g;

  for (const scope of SCOPES) {
    for (const file of walk(scope)) {
      const rel = file.replace(/\\/g, "/");
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      let match: RegExpExecArray | null;
      FROM_RE.lastIndex = 0;
      while ((match = FROM_RE.exec(src))) {
        const window = src.slice(match.index, match.index + 1500);
        const insertIdx = window.search(/\.insert\s*\(/);
        if (insertIdx === -1) continue;
        const payload = window.slice(insertIdx, insertIdx + 800);
        const hasWh = /warehouse_id\s*:/.test(payload);
        const hasBiz = /business_id\s*:/.test(payload);
        if (!hasWh || !hasBiz) {
          offenders.push({
            file: rel,
            reason: `stock_adjustments insert missing ${
              [!hasWh && "warehouse_id", !hasBiz && "business_id"]
                .filter(Boolean).join(" + ")
            }`,
          });
        }
      }
    }
  }
  return offenders;
}

describe("stock_adjustments inserts must carry warehouse_id + business_id", () => {
  it("no client code inserts an adjustment without scope keys", () => {
    const offenders = findOffenders();
    expect(
      offenders,
      `These insert paths bypass warehouse attribution and will trigger a ` +
        `23502 NOT NULL violation. Add warehouse_id (and business_id) to the ` +
        `payload, or — if intentionally pre-scope — add the file to the ` +
        `ALLOWLIST in this test with a justification.\n\nOffenders:\n` +
        offenders.map((o) => `  - ${o.file}: ${o.reason}`).join("\n"),
    ).toEqual([]);
  });
});
