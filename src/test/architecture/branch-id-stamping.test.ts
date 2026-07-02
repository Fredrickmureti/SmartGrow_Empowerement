/**
 * Architecture guard: every WRITE path on company-scoped accounting tables
 * (invoices, bills, sales orders, estimates, etc.) must include `branch_id`
 * so the branch dimension is preserved end-to-end and per-branch reporting
 * is honest.
 *
 * Strategy:
 *   - Locate every `.from("<table>").insert(<payload>)` call site.
 *   - For each, scan the next ~800 chars (the inline payload object) for
 *     a literal `branch_id:` key. Whole-file fallback is INTENTIONALLY
 *     removed — it allowed a single comment to satisfy the guard.
 *   - File-level allowlist for legitimate non-stamping callers (e.g. a
 *     shadow-copy hook that only mirrors fields from another row).
 *
 * Companion to no-org-identity-reads.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "test") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  table: string;
  snippet: string;
}

/**
 * Files that legitimately bypass branch_id stamping (e.g. they only relay
 * an existing row's branch_id from a fetched record, or they are pure
 * server-side replay paths). Adding to this list requires a justification
 * comment.
 */
const ALLOWLIST = new Set<string>([
  // useVendorCreditNotes.ts only `.update()`s bills (to apply credit) and
  // then inserts into a junction table — it never inserts into `bills`.
  // The arch-guard regex non-greedily matches `.from("bills")` to a
  // downstream `.insert(` of a different table, which is a false positive.
  "src/hooks/useVendorCreditNotes.ts",
]);

function findInsertViolations(table: string): Violation[] {
  const files = walk(SRC);
  const violations: Violation[] = [];
  // Match `.from("<table>")` followed by `.insert(` with NO intervening
  // `.from(` (which would mean we crossed into a different table's chain
  // and the original `.from(<table>)` was a select/update/delete, not an
  // insert). Same applies to a `;` (statement terminator).
  const fromRe = new RegExp(
    `\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)((?:(?!\\.from\\(|;)[\\s\\S]){0,600})\\.insert\\(`,
    "g",
  );

  for (const file of files) {
    if (file.includes("/test/") || file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const rel = file.replace(SRC, "src");
    if (ALLOWLIST.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(text)) !== null) {
      // Inspect the payload immediately after `.insert(` — look at the next
      // ~800 chars for a literal `branch_id:` key OR the assembled-payload
      // pattern where the inserted object is a spread of a variable that the
      // file has already populated (e.g. `insertData = { ..., branch_id }`).
      const window = text.slice(m.index, m.index + 800);
      const inlineKey = /branch_id\s*:/.test(window);
      const spreadAssembledNearby = /branch_id\s*:[\s\S]{0,1500}\.insert\(/.test(text.slice(Math.max(0, m.index - 1500), m.index + 800));
      if (!inlineKey && !spreadAssembledNearby) {
        violations.push({
          file: rel,
          table,
          snippet: text.slice(m.index, m.index + 160).replace(/\s+/g, " "),
        });
        break; // one violation per file is enough
      }
    }
  }
  return violations;
}

describe("Architecture: branch_id stamping on accounting writes", () => {
  // Tables that carry a branch_id column and should always be stamped on
  // insert. Add new branch-aware accounting tables here as they're created.
  const GUARDED_TABLES = [
    "invoices",
    "bills",
    "journal_entries",         // discouraged direct insert; RPC propagates
    "estimates",
    "proforma_invoices",
    "recurring_invoices",
    "sales_orders",
    "delivery_notes",
    "vendor_credit_notes",
  ];

  for (const table of GUARDED_TABLES) {
    it(`every ${table}.insert must include branch_id`, () => {
      const v = findInsertViolations(table);
      expect(
        v,
        `Found inserts to '${table}' missing branch_id:\n${JSON.stringify(v, null, 2)}`,
      ).toEqual([]);
    });
  }
});
