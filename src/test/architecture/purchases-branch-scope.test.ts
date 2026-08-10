/**
 * Architecture guard — Purchases module branch scoping.
 *
 * Every Supabase read against a branch-scoped purchases table from
 * src/hooks or src/pages MUST be paired with either
 *   - applyBranchFilter(...)   (matches branch + legacy NULL)
 *   - .eq("branch_id", ...)    (explicit branch filter)
 * within ~800 chars of the .from(...).select(...) chain.
 *
 * Every .insert(...) into the same tables MUST include a branch_id key in
 * the payload so child rows inherit branch isolation.
 *
 * This is the read/write twin of inventory-branch-filter.test.ts and
 * exists to prevent regressions where a new query forgets the branch
 * filter and silently leaks data from sibling branches.
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
  "expenses",
  "vendor_pricelists",
  "vendor_statements",
] as const;

const SCOPES = ["src/hooks", "src/pages"];

// Files that legitimately query these tables without a branch filter — must
// be reviewed and explicitly listed here to escape the guard.
const READ_ALLOWLIST = new Set<string>([
  // (none)
]);
const WRITE_ALLOWLIST = new Set<string>([
  // (none)
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

const tableUnion = TABLES.map((t) => `["']${t}["']`).join("|");
const SELECT_RE = new RegExp(
  `\\.from\\(\\s*(?:${tableUnion})\\s*\\)[\\s\\S]{0,800}?\\.select\\(`,
  "g",
);
// The window between `.from(<table>)` and `.insert(` must not cross another
// `.from(` — otherwise a read on a guarded table binds to an unrelated insert
// on a different (non-guarded) table further down the file.
const INSERT_RE = new RegExp(
  `\\.from\\(\\s*(?:${tableUnion})\\s*\\)((?:(?!\\.from\\()[\\s\\S]){0,1200}?)\\.insert\\(\\s*([\\s\\S]{0,1500}?)\\)`,
  "g",
);

describe("purchases module — branch scoping is enforced", () => {
  it("every .from(<purchases-table>).select() pairs with applyBranchFilter or .eq(branch_id)", () => {
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(scope)) {
        const rel = file.replace(/\\/g, "/");
        if (READ_ALLOWLIST.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        let m: RegExpExecArray | null;
        SELECT_RE.lastIndex = 0;
        while ((m = SELECT_RE.exec(src)) !== null) {
          const window = src.slice(m.index, m.index + 1600);
          const hasBranch =
            /applyBranchFilter\s*\(/.test(window) ||
            /\.eq\(\s*["']branch_id["']/.test(window);
          if (!hasBranch) {
            offenders.push(`${rel}: select() near char ${m.index} missing branch filter`);
          }
        }
      }
    }
    expect(
      offenders,
      `Purchases reads must include a branch filter to prevent ` +
        `cross-branch contamination. Add applyBranchFilter(query, ` +
        `currentBranch?.id ?? null) right after the .select() chain.\n\n` +
        `Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every .insert() into a purchases table includes a branch_id key", () => {
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(scope)) {
        const rel = file.replace(/\\/g, "/");
        if (WRITE_ALLOWLIST.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        let m: RegExpExecArray | null;
        INSERT_RE.lastIndex = 0;
        while ((m = INSERT_RE.exec(src)) !== null) {
          const payload = m[2] ?? "";
          if (!/branch_id\s*:/.test(payload)) {
            offenders.push(`${rel}: insert() near char ${m.index} missing branch_id in payload`);
          }
        }
      }
    }
    expect(
      offenders,
      `Purchases writes must stamp branch_id (use parent row's branch_id ` +
        `when the child inherits, otherwise currentBranch?.id ?? null).\n\n` +
        `Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
