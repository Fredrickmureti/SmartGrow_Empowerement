/**
 * Banking Wave 1 (Phase 4d) + Reconciliation Phase 4 — rule authoring is a
 * server-owned write seam, and there is exactly ONE rule table.
 *
 * `bank_reconciliation_rules` is the table the executor
 * (`apply_reconciliation_rules`) actually reads, so it is the only table the
 * UI may author into. The legacy `transaction_categorization_rules` table was
 * a parallel store the engine never consulted: rules written there silently
 * did nothing. This ratchet keeps the browser off both tables and keeps the
 * dead one out of application code entirely.
 *
 * The only legal writers are:
 *   bank_reconciliation_rule_upsert / bank_reconciliation_rule_delete
 *
 * INSERT/UPDATE/DELETE on the table is revoked from `authenticated`, so any
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

  it("no application code reads or writes the retired categorization rules table", () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, "src"))) {
      if (file.endsWith("integrations/supabase/types.ts")) continue;
      if (file.endsWith("lib/businessScopedTables.ts")) continue;
      const src = readFileSync(file, "utf8");
      if (
        src.includes("transaction_categorization_rule_upsert") ||
        src.includes("transaction_categorization_rule_delete") ||
        /from\(\s*["'`]transaction_categorization_rules["'`]/.test(src)
      ) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no client code stamps organization_id onto a rule payload", () => {
    const src = readFileSync(
      join(root, "src/hooks/finance/useReconciliationRules.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/organization_id:\s*(currentOrg|organization)/);
  });
});

