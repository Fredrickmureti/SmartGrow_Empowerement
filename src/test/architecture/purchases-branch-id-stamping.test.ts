/**
 * Architecture guard — Purchases write-side branch stamping.
 *
 * Independent (write-only) twin of purchases-branch-scope.test.ts. Lives in
 * its own file so refactors of the read-side guard cannot accidentally
 * weaken write-side coverage.
 *
 * Every .from(<purchases-table>).insert(...) in src/hooks or src/pages
 * MUST include a `branch_id:` key in the payload so child rows inherit
 * branch isolation. The branch-bearing tables are the ones that have a
 * `branch_id` column in the database (verified live).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TABLES = [
  "bills",
  "bill_payments",
  "purchase_orders",
  "purchase_returns",
  "vendor_credit_notes",
  "rfqs",
  "supplier_item_terms",
] as const;

const SCOPES = ["src/hooks", "src/pages"];

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

const tableUnion = TABLES.map((t) => `["']${t}["']`).join("|");
// The window between `.from(<table>)` and `.insert(` must not cross another
// `.from(` — otherwise a read on a guarded table binds to an unrelated insert
// on a different (non-guarded) table further down the file.
const INSERT_RE = new RegExp(
  `\\.from\\(\\s*(?:${tableUnion})\\s*\\)((?:(?!\\.from\\()[\\s\\S]){0,1200}?)\\.insert\\(\\s*([\\s\\S]{0,1500}?)\\)`,
  "g",
);

describe("purchases module — write-side branch_id stamping", () => {
  it("every .insert() into a branch-bearing purchases table includes branch_id", () => {
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(scope)) {
        const rel = file.replace(/\\/g, "/");
        const src = readFileSync(file, "utf8");
        let m: RegExpExecArray | null;
        INSERT_RE.lastIndex = 0;
        while ((m = INSERT_RE.exec(src)) !== null) {
          const payload = m[2] ?? "";
          if (!/branch_id\s*:/.test(payload)) {
            offenders.push(`${rel}: insert() near char ${m.index} missing branch_id`);
          }
        }
      }
    }
    expect(
      offenders,
      `Purchases writes must stamp branch_id (use parent row's branch_id ` +
        `when the child inherits, otherwise currentBranch?.id ?? null).\n\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
