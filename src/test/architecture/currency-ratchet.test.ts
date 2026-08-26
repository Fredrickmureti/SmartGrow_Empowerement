/**
 * Phase 9.5 — the currency ratchet.
 *
 * These are regression brakes, not an audit. They fail the build when new code
 * re-introduces a defect the currency remediation already removed:
 *
 *   1. No `COALESCE(<rate>, 1)` in any function body or view definition. A
 *      missing rate is an absence (NULL), never parity (ADR 0136). History is
 *      immutable, so migration scanning starts at the ratchet baseline below.
 *   2. Every rate-bearing table is registered in
 *      docs/architecture/currency-rate-bearing-tables.md — either with a
 *      stamping trigger, or on the documented rate-fixed allowlist with a
 *      stated reason. A new rate column that is registered nowhere fails.
 *   3. Every write policy on a currency/rate table carries a role predicate;
 *      company membership alone must never authorise a rate write.
 *   4. No module re-introduces a private currency-symbol map, and no FX module
 *      hardcodes a money decimal count — both come from
 *      src/lib/currency/catalogue.ts.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const MIGRATIONS = "supabase/migrations";

/**
 * Migrations already applied to production cannot be edited, so the scan starts
 * at the Phase 9 migration. Everything authored from here on is held to the
 * invariants above.
 */
const RATCHET_BASELINE = "20260826082801";

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "__snapshots__") continue;
      out.push(...walk(p, match));
    } else if (match.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const newMigrations = walk(MIGRATIONS, /\.sql$/i).filter(
  (f) => basename(f).slice(0, 14) >= RATCHET_BASELINE,
);

describe("currency ratchet — a missing rate is never parity", () => {
  it("no migration authored after the baseline coalesces a rate to 1", () => {
    // COALESCE(<anything mentioning a rate>, 1) — including the
    // COALESCE(NULLIF(rate, 0), 1) shape that Phase 1 removed.
    const parity =
      /coalesce\s*\(\s*(?:nullif\s*\()?[^(),]*(?:exchange_rate|currency_rate|fx_rate|\brate\b)[^(),]*(?:,\s*0\s*\))?\s*,\s*1(?:\.0*)?\s*\)/i;
    const offenders: string[] = [];
    for (const file of newMigrations) {
      const sql = readFileSync(file, "utf8");
      for (const line of sql.split("\n")) {
        if (parity.test(line)) offenders.push(`${basename(file)}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      "a rate that is not on file must propagate NULL, never 1",
    ).toEqual([]);
  });

  it("no migration authored after the baseline defaults a rate column to 1", () => {
    const offenders: string[] = [];
    for (const file of newMigrations) {
      const sql = readFileSync(file, "utf8");
      const bad =
        /(exchange_rate|currency_rate|fx_rate)\s+numeric[^,;]*default\s+1\b/gi;
      for (const m of sql.matchAll(bad)) offenders.push(`${basename(file)}: ${m[0]}`);
    }
    expect(
      offenders,
      "a rate column must have no default; the stamping trigger supplies it",
    ).toEqual([]);
  });
});

describe("currency ratchet — every rate-bearing table is registered", () => {
  const register = readFileSync(
    "docs/architecture/currency-rate-bearing-tables.md",
    "utf8",
  );
  const [, stampedSection = "", allowlistSection = ""] = register.split(/^## /m);

  const stamped = new Set(
    [...stampedSection.matchAll(/^`([a-z_]+)`\s*\|/gm)].map((m) => m[1]),
  );
  const allowlisted = new Set(
    [...allowlistSection.matchAll(/^`([a-z_]+)`\s*\|/gm)].map((m) => m[1]),
  );

  it("the register is non-empty and its two lists are disjoint", () => {
    expect(stamped.size).toBeGreaterThan(10);
    expect(allowlisted.size).toBeGreaterThan(0);
    for (const t of stamped) {
      expect(allowlisted.has(t), `${t} is in both lists`).toBe(false);
    }
  });

  it("every allowlisted table states why it carries no stamping trigger", () => {
    for (const line of allowlistSection.split("\n")) {
      const m = /^`([a-z_]+)`\s*\|([^|]*)\|(.*)$/.exec(line);
      if (!m) continue;
      expect(m[2].trim().length, `${m[1]} must name its rate column`).toBeGreaterThan(0);
      expect(
        m[3].trim().length,
        `${m[1]} must state why it is rate-fixed by construction`,
      ).toBeGreaterThan(40);
    }
  });

  it("a new table with a rate column is registered in one of the two lists", () => {
    const offenders: string[] = [];
    for (const file of newMigrations) {
      const sql = readFileSync(file, "utf8");
      const creates =
        /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
      for (const m of sql.matchAll(creates)) {
        const [, table, body] = m;
        if (!/(exchange_rate|currency_rate|fx_rate|\brate\b)\s+numeric/i.test(body)) continue;
        if (!stamped.has(table) && !allowlisted.has(table)) {
          offenders.push(`${table} (${basename(file)})`);
        }
      }
    }
    expect(
      offenders,
      "register the table in docs/architecture/currency-rate-bearing-tables.md",
    ).toEqual([]);
  });
});

describe("currency ratchet — rate writes carry a role predicate", () => {
  const CURRENCY_TABLES = [
    "exchange_rates",
    "business_active_currencies",
    "currencies",
  ];
  const ROLE_PREDICATES =
    /is_finance_manager|has_finance_permission|has_org_role|is_platform_admin|has_role/i;

  it("no write policy on a currency table is authorised by membership alone", () => {
    const offenders: string[] = [];
    for (const file of walk(MIGRATIONS, /\.sql$/i)) {
      if (basename(file).slice(0, 14) < RATCHET_BASELINE) continue;
      const sql = readFileSync(file, "utf8");
      const policies =
        /create\s+policy\s+"?([\w\s.-]+?)"?\s+on\s+public\.([a-z_]+)([\s\S]*?);/gi;
      for (const m of sql.matchAll(policies)) {
        const [whole, name, table] = m;
        if (!CURRENCY_TABLES.includes(table)) continue;
        const isWrite = /for\s+(insert|update|delete|all)/i.test(whole);
        if (!isWrite) continue;
        if (!ROLE_PREDICATES.test(whole)) {
          offenders.push(`${table}.${name} (${basename(file)})`);
        }
      }
    }
    expect(
      offenders,
      "a currency/rate write policy must test a finance or admin role, not only company access",
    ).toEqual([]);
  });
});

describe("currency ratchet — presentation stays canonical", () => {
  const CATALOGUE = "src/lib/currency/catalogue.ts";
  const appFiles = walk("src", /\.(ts|tsx)$/).filter(
    (f) => !/\.test\.(ts|tsx)$/.test(f) && !f.includes("src/test/"),
  );

  it("no module keeps its own currency-symbol map", () => {
    // A record literal mapping ISO codes to symbols, e.g. { USD: "$", EUR: "€" }.
    const symbolMap = /["']?(USD|EUR|GBP|KES|JPY)["']?\s*:\s*["'](?:\$|€|£|¥|KSh|Ksh)/;
    const offenders = appFiles.filter(
      (f) => !f.endsWith(CATALOGUE.replace("src/", "src/")) &&
        !f.includes("lib/currency/catalogue") &&
        symbolMap.test(readFileSync(f, "utf8")),
    );
    expect(
      offenders,
      "symbols come from getCurrencySymbol() in src/lib/currency/catalogue.ts",
    ).toEqual([]);
  });

  it("the FX modules never hardcode a money decimal count", () => {
    const fxFiles = [
      ...walk("src/services/fx", /\.(ts|tsx)$/),
      ...walk("src/lib/currency", /\.(ts|tsx)$/),
    ].filter((f) => !/\.test\.(ts|tsx)$/.test(f));
    const offenders: string[] = [];
    for (const f of fxFiles) {
      const src = readFileSync(f, "utf8");
      for (const line of src.split("\n")) {
        if (/(minimum|maximum)FractionDigits\s*:\s*\d/.test(line) || /toFixed\(\s*2\s*\)/.test(line)) {
          offenders.push(`${f}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "decimals come from getCurrencyDecimals(); ISO minor units differ per currency",
    ).toEqual([]);
  });

  it("the catalogue remains the single source of decimals and symbols", () => {
    const src = readFileSync(CATALOGUE, "utf8");
    expect(src).toContain("export function getCurrencyDecimals");
    expect(src).toContain("export function getCurrencySymbol");
  });
});
