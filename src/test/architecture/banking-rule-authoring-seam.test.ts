/**
 * Banking Wave 1 (Phase 4d) — rule authoring is a server-owned write seam.
 *
 * `bank_reconciliation_rules` and `transaction_categorization_rules` drive
 * automated matching and categorization, so a rule row is an accounting
 * instruction, not user preference. Authoring them from the browser meant the
 * client stamped `organization_id` / `business_id` and could point a rule at a
 * counterpart account belonging to another company.
 *
 * The only legal writers are:
 *   bank_reconciliation_rule_upsert / bank_reconciliation_rule_delete
 *   transaction_categorization_rule_upsert / transaction_categorization_rule_delete
 *
 * INSERT/UPDATE/DELETE on both tables is revoked from `authenticated`, so any
 * direct browser write is a bug — this ratchet fails first.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

const root = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__snapshots__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const RULE_TABLES = [
  "bank_reconciliation_rules",
  "transaction_categorization_rules",
] as const;

describe("bank rule authoring seam", () => {
  for (const table of RULE_TABLES) {
    it(`no application code writes ${table} directly`, () => {
      const writeCall = new RegExp(
        `\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)\\s*(?:[\\s\\S]{0,400}?)\\.(insert|update|upsert|delete)\\(`,
      );
      const offenders: string[] = [];
      for (const file of walk(join(root, "src"))) {
        const src = readFileSync(file, "utf8");
        if (!src.includes(table)) continue;
        if (writeCall.test(src)) offenders.push(relative(root, file));
      }
      expect(offenders).toEqual([]);
    });
  }

  it("useReconciliationRules mutates only through the seam RPCs", () => {
    const src = readFileSync(
      join(root, "src/hooks/finance/useReconciliationRules.ts"),
      "utf8",
    );
    expect(src).toContain("bank_reconciliation_rule_upsert");
    expect(src).toContain("bank_reconciliation_rule_delete");
  });

  it("useTransactionRules mutates only through the seam RPCs", () => {
    const src = readFileSync(join(root, "src/hooks/useTransactionRules.ts"), "utf8");
    expect(src).toContain("transaction_categorization_rule_upsert");
    expect(src).toContain("transaction_categorization_rule_delete");
  });

  it("no client code stamps organization_id onto a rule payload", () => {
    for (const file of [
      "src/hooks/finance/useReconciliationRules.ts",
      "src/hooks/useTransactionRules.ts",
    ]) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src).not.toMatch(/organization_id:\s*(currentOrg|organization)/);
    }
  });
});
