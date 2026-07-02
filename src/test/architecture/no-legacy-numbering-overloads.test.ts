/**
 * Architecture guard — fails CI if a future migration re-introduces
 * the legacy 1-arg or 2-arg overloads of the document-numbering RPCs.
 *
 * Only the 3-arg branch-aware signatures are allowed:
 *   generate_invoice_number(p_organization_id, p_business_id, p_branch_id)
 *   get_next_bill_number(_org_id, _business_id, _branch_id)
 *   get_next_estimate_number(_org_id, _business_id, _branch_id)
 *   get_next_receipt_number(_org_id, _business_id, _branch_id)
 *
 * Reintroducing a shorter overload would let callers silently bypass
 * branch-level sequence isolation and re-issue duplicate document numbers
 * across branches.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const NUMBERING_FNS = [
  "generate_invoice_number",
  "get_next_bill_number",
  "get_next_estimate_number",
  "get_next_receipt_number",
];

const MIGRATIONS_DIR = "supabase/migrations";

/**
 * Phase A (Settings audit) dropped every legacy 1-arg / 2-arg overload
 * in this migration. Anything CREATEd before it has already been removed
 * from the live database and is irrelevant — we only police migrations
 * authored AFTER the cleanup, since those are the ones that could
 * regress the contract going forward.
 */
const PHASE_A_DROP_PREFIX = "20260427115707";

function migrationFiles(): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => f >= PHASE_A_DROP_PREFIX)
    .map((f) => join(MIGRATIONS_DIR, f))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

/**
 * Count UUID arguments in a `CREATE [OR REPLACE] FUNCTION name(...)` head.
 * Returns -1 if no parens were found.
 */
function uuidArgCount(head: string): number {
  const open = head.indexOf("(");
  const close = head.indexOf(")", open);
  if (open === -1 || close === -1) return -1;
  const args = head.slice(open + 1, close);
  if (!args.trim()) return 0;
  // Count `uuid` tokens — robust to default expressions and casing.
  const matches = args.match(/\buuid\b/gi);
  return matches ? matches.length : 0;
}

describe("Numbering RPCs — no legacy overloads", () => {
  const files = migrationFiles();

  for (const fn of NUMBERING_FNS) {
    it(`${fn} is never re-declared with fewer than 3 uuid args`, () => {
      // Match either `CREATE OR REPLACE FUNCTION public.fn(...)` or without `public.`.
      const re = new RegExp(
        `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${fn}\\s*\\([^)]*\\)`,
        "gi",
      );

      const violations: string[] = [];

      for (const file of files) {
        const sql = readFileSync(file, "utf8");
        const matches = sql.match(re) ?? [];
        for (const head of matches) {
          const n = uuidArgCount(head);
          // Acceptable signature: exactly the 3-arg branch-aware version.
          // (n === -1 shouldn't happen because re requires parens; treat as ok.)
          if (n !== -1 && n < 3) {
            violations.push(`${file}: ${head.replace(/\s+/g, " ").trim()}`);
          }
        }
      }

      expect(
        violations,
        `Legacy ${fn} overload re-introduced — only the 3-arg ` +
          `(org, business, branch) signature is allowed.\n` +
          violations.join("\n"),
      ).toEqual([]);
    });
  }
});
