/**
 * Finance Wave 2, Phase 17 — the bank feed edge function is TRANSPORT only.
 *
 * ADR-0143. `supabase/functions/sync-bank-transactions` may open a run, ask a
 * provider adapter for normalized lines, hand them to the one ingestion engine
 * and close the run. It may not own anything accounting-shaped:
 *   - no write to `bank_transactions` / `bank_statements` (the engine owns them),
 *   - no categorization rule engine in TypeScript (the database owns rules),
 *   - no write of a balance onto `bank_accounts` (a balance is derived, ADR-0141),
 *   - no feed state on `bank_accounts` (state lives on the connection + runs),
 *   - provider HTTP calls only inside `providers/`.
 *
 * These are read as source-text assertions on purpose: a future engineer cannot
 * satisfy them with a comment, and reintroducing the legacy shape fails the build.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

const root = process.cwd();
const fnDir = join(root, "supabase/functions/sync-bank-transactions");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const files = existsSync(fnDir) ? walk(fnDir) : [];
const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(root, f);

describe("bank feed transport ownership (ADR-0143)", () => {
  it("the feed function exists and is split into transport + providers + advisory", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const expected of ["index.ts", "providers/index.ts", "aiAdvisory.ts"]) {
      expect(existsSync(join(fnDir, expected)), `${expected} is missing`).toBe(true);
    }
  });

  it("never writes bank_transactions or bank_statements directly", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = read(file);
      for (const table of ["bank_transactions", "bank_statements"]) {
        const write = new RegExp(
          `from\\(\\s*['"\`]${table}['"\`]\\s*\\)[\\s\\S]{0,200}?\\.(insert|upsert|update|delete)\\(`,
        );
        if (write.test(src)) offenders.push(`${rel(file)} → ${table}`);
      }
    }
    expect(offenders, `only bank_statement_import_batch may write bank lines:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("uses the ingestion engine and the run lifecycle seams, not its own", () => {
    const entry = read(join(fnDir, "index.ts"));
    for (const seam of [
      "bank_feed_run_start",
      "bank_feed_run_finish",
      "bank_feed_run_fail",
      "bank_statement_import_batch",
    ]) {
      expect(entry.includes(seam), `index.ts must go through ${seam}`).toBe(true);
    }
  });

  it("contains no TypeScript categorization rule engine", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = read(file);
      // Reading rules client-side, or deriving `category` locally, is the
      // legacy shape: categorization is `bank_transaction_apply_rules`.
      if (/from\(\s*['"`]bank_(transaction_)?rules['"`]/.test(src)) offenders.push(`${rel(file)} reads rules`);
      if (/bank_(transaction_)?categorization_rules/.test(src)) offenders.push(`${rel(file)} references a rule table`);
      if (/\bcategory\s*[:=]\s*(?!undefined|null)/.test(src) && !/ai_suggested_category/.test(src)) {
        offenders.push(`${rel(file)} assigns category`);
      }
    }
    expect(offenders, `categorization is server-side:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("keeps AI advisory: it may only suggest, never set the accounting category", () => {
    const advisory = read(join(fnDir, "aiAdvisory.ts"));
    expect(advisory).toMatch(/ai_suggested_category/);
    expect(advisory).toMatch(/ai_confidence/);
    expect(/(^|[^_])\bcategory:\s/m.test(advisory), "aiAdvisory must not set `category`").toBe(false);
  });

  it("never writes a balance or feed state back onto bank_accounts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = read(file);
      if (/from\(\s*['"`]bank_accounts['"`]\s*\)[\s\S]{0,200}?\.(insert|upsert|update|delete)\(/.test(src)) {
        offenders.push(`${rel(file)} writes bank_accounts`);
      }
      for (const legacy of ["current_balance", "sync_status", "sync_error", "last_sync_at"]) {
        if (new RegExp(`\\b${legacy}\\b`).test(src)) offenders.push(`${rel(file)} references ${legacy}`);
      }
    }
    expect(
      offenders,
      `a balance is derived (ADR-0141) and feed state lives on the connection (ADR-0143):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps provider transport inside providers/", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (rel(file).includes("/providers/")) continue;
      const src = read(file);
      if (/\bfetch\(\s*['"`]https?:\/\//.test(src)) offenders.push(`${rel(file)} calls a provider directly`);
    }
    expect(offenders, `provider HTTP belongs in providers/:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("refuses unimplemented providers and manual sources at the registry", () => {
    const registry = read(join(fnDir, "providers/index.ts"));
    expect(registry).toMatch(/BANK_FEED_UNSUPPORTED_PROVIDER/);
    expect(registry).toMatch(/manual/);
  });
});
