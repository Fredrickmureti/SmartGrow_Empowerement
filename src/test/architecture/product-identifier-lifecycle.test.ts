/**
 * Product identifier (barcode) lifecycle guards.
 *
 * Two production defects are pinned here:
 *
 *  1. Retiring a barcode archives the row and keeps the code. The per-product
 *     uniqueness index used to ignore `status`, so a retired code reserved
 *     itself forever against its own product and re-adding it surfaced as an
 *     opaque HTTP 409. The index must stay partial on `status = 'active'`,
 *     and `upsert_product_identifier` must revive rather than duplicate and
 *     must never let a unique_violation escape.
 *
 *  2. `product_reorder_rules` is branch-scoped and has no relationship to
 *     `warehouses`; embedding one makes PostgREST reject the request (400).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(p, "utf8");

function sqlMigrations(): string[] {
  const dir = join(process.cwd(), "supabase", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => read(join(dir, f)));
}

function clientSources(): Array<{ file: string; body: string }> {
  const out: Array<{ file: string; body: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push({ file: full, body: read(full) });
    }
  };
  walk(join(process.cwd(), "src"));
  return out;
}

describe("product identifier lifecycle", () => {
  it("the per-product uniqueness index is scoped to live identifiers", () => {
    const migration = sqlMigrations().find(
      (sql) =>
        sql.includes("product_identifiers_product_kind_code_uidx") &&
        /WHERE\s+status\s*=\s*'active'/i.test(sql),
    );
    expect(
      migration,
      "a migration must define product_identifiers_product_kind_code_uidx as partial on status='active'",
    ).toBeTruthy();
  });

  it("the upsert RPC revives retired codes and never leaks a unique_violation", () => {
    const migration = sqlMigrations().find((sql) =>
      sql.includes("CREATE OR REPLACE FUNCTION public.upsert_product_identifier"),
    );
    expect(migration).toBeTruthy();
    const latest = sqlMigrations()
      .filter((sql) => sql.includes("CREATE OR REPLACE FUNCTION public.upsert_product_identifier"))
      .pop()!;
    expect(latest).toMatch(/EXCEPTION WHEN unique_violation/i);
    expect(latest).toContain("'revived'");
    expect(latest).toMatch(/status\s*<>\s*'active'/);
  });

  it("the lifecycle is proven by a SQL suite", () => {
    const tests = join(process.cwd(), "supabase", "tests");
    expect(readdirSync(tests)).toContain("product_identifier_lifecycle_test.sql");
    const suite = read(join(tests, "product_identifier_lifecycle_test.sql"));
    for (const claim of [
      "revived",
      "retire_product_identifier",
      "duplicate",
      "idempotent",
      "unique_violation",
    ]) {
      expect(suite).toContain(claim);
    }
  });

  it("no client query embeds warehouses on product_reorder_rules", () => {
    const offenders = clientSources().filter(
      ({ file, body }) =>
        !file.includes("__tests__") &&
        !file.includes("/test/") &&
        /from\(\s*["']product_reorder_rules["']\s*\)[\s\S]{0,400}?warehouses!/.test(body),
    );
    expect(
      offenders.map((o) => o.file),
      "product_reorder_rules has no relationship to warehouses — filter on its own branch_id",
    ).toEqual([]);
  });
});
