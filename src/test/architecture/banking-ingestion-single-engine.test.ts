/**
 * Banking Wave 1, Phase 3 — statement ingestion is ONE server-side engine.
 *
 * `public.bank_statement_import_batch` is the only way bank statement rows
 * enter the ledger. It owns, inside a single transaction:
 *   - the dedup identity (`bank_transaction_fingerprint`, or the provider's
 *     own external id when supplied),
 *   - the categorization rules (`bank_transaction_apply_rules`),
 *   - the account-lifecycle and fiscal-period gates,
 *   - the statement header bookkeeping and the `banking.statement.imported`
 *     business event.
 *
 * Consequently no client and no edge function may insert/update/delete
 * `bank_transactions` or `bank_statements`, and neither may re-implement
 * hashing or categorization on its own. INSERT/UPDATE/DELETE on both tables
 * is revoked from `authenticated`, so a direct write is a runtime failure —
 * this test makes it a build failure instead.
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

const INGESTED_TABLES = ["bank_transactions", "bank_statements"] as const;

function writeCall(table: string): RegExp {
  return new RegExp(
    String.raw`\.from\(\s*["'\`]${table}["'\`]\s*\)(?:[\s\S]{0,400}?)\.(insert|upsert)\(`,
  );
}

const WIZARD = "src/features/finance/banking/import/ImportStatementWizardPage.tsx";
const FEED = "supabase/functions/sync-bank-transactions/index.ts";

describe("bank statement ingestion — single engine", () => {
  it("no application code inserts statement rows directly", () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, "src"))) {
      const src = readFileSync(file, "utf8");
      for (const table of INGESTED_TABLES) {
        if (!src.includes(table)) continue;
        if (writeCall(table).test(src)) {
          offenders.push(`${relative(root, file)} → ${table}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no edge function inserts statement rows directly", () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, "supabase/functions"))) {
      const src = readFileSync(file, "utf8");
      for (const table of INGESTED_TABLES) {
        if (!src.includes(table)) continue;
        if (writeCall(table).test(src)) {
          offenders.push(`${relative(root, file)} → ${table}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the manual import wizard hands rows to the engine and nothing else", () => {
    const src = readFileSync(join(root, WIZARD), "utf8");
    expect(src).toContain("bank_statement_import_batch");
    // Dedup identity and categorization are server concerns now.
    expect(src).not.toContain("applyRulesToTransaction");
    expect(src).not.toMatch(/batchStart|BATCH_SIZE/);
  });

  it("the provider feed sync persists through the same engine", () => {
    const src = readFileSync(join(root, FEED), "utf8");
    expect(src).toContain("bank_statement_import_batch");
    // No parallel "does it already exist / then update" persistence path.
    expect(src).not.toMatch(/\.from\(\s*['"`]bank_transactions['"`]\s*\)/);
  });

  it("the browser hash helper is preview-only, never a persisted identity", () => {
    // generateTransactionHash may still power duplicate *preview* counts, but
    // only the wizard's preview path may call it — never an insert payload.
    const callers: string[] = [];
    for (const file of walk(join(root, "src"))) {
      const src = readFileSync(file, "utf8");
      if (!/generateTransactionHash\s*\(/.test(src)) continue;
      if (file.endsWith("src/lib/bankStatementParsers/index.ts")) continue;
      callers.push(relative(root, file));
    }
    expect(callers).toEqual([WIZARD]);
  });
});
