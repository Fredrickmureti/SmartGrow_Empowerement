import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Guard against the inventory account-role naming drift that broke fresh
 * tenants in May 2026:
 *   - system_account_roles.role_key uses canonical 'inventory'.
 *   - default_account_settings.setting_key must use the same canonical key.
 *   - A prior migration (20260517143924_*) wrote 'inventory_asset' instead,
 *     which the validate_default_account_setting trigger correctly rejected.
 *
 * Any migration that introduces 'inventory_asset' as a real key (rather
 * than as an alias in canonicalize_role_key or a backfill that COLLAPSES
 * the legacy spelling) must fail this test.
 */
describe("inventory role-key canonicalization", () => {
  const MIGRATIONS_DIR = "supabase/migrations";
  const ALIAS_MIGRATION = "_inventory_role_key_canonical";

  const allMigrations = readdirSync(MIGRATIONS_DIR).filter((f) =>
    f.endsWith(".sql"),
  );

  // The alias migration is identified by content (auto-named timestamp+uuid
  // files don't carry semantic filenames). Any migration that BOTH defines
  // canonicalize_role_key AND contains the 'inventory_asset' → 'inventory'
  // CASE branch is considered an alias migration.
  const aliasMigrations = allMigrations.filter((f) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    return (
      /CREATE OR REPLACE FUNCTION public\.canonicalize_role_key/.test(sql) &&
      /'inventory_asset'\s+THEN\s+'inventory'/.test(sql)
    );
  });

  it("no migration writes setting_key='inventory_asset' as a canonical key", () => {
    const offenders: string[] = [];

    for (const file of allMigrations) {
      const path = join(MIGRATIONS_DIR, file);
      const sql = readFileSync(path, "utf8");

      if (!sql.includes("inventory_asset")) continue;

      // Alias migrations are allowed to mention the legacy spelling (case
      // branch + idempotent backfill that collapses it onto the canonical
      // key).
      if (aliasMigrations.includes(file)) continue;

      // Historical drift migrations are part of project history; later
      // canonicalization/repair migrations supersede them. Allow them
      // explicitly so the test stays focused on future authoritative definers.
      if (file.startsWith("20260517143924")) continue;
      if (file.startsWith("20260709223205")) continue;

      offenders.push(file);
    }

    expect(
      offenders,
      `Migrations referencing 'inventory_asset' outside the canonicalization alias:\n` +
        offenders.join("\n") +
        `\nUse setting_key='inventory' (canonical) instead.`,
    ).toEqual([]);
  });

  it("a canonicalization alias migration is present and writes the canonical key", () => {
    expect(
      aliasMigrations.length,
      "Expected at least one migration that aliases inventory_asset → inventory and uses the canonical key",
    ).toBeGreaterThan(0);

    // At least one alias migration must also write setting_key='inventory'
    // via ensure_inventory_gl_accounts (the auto-provisioning UPSERT).
    const hasCanonicalUpsert = aliasMigrations.some((f) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      return /VALUES\s*\([^)]*'inventory'\s*,\s*v_inv\s*\)/.test(sql);
    });
    expect(
      hasCanonicalUpsert,
      "Expected an alias migration to UPSERT default_account_settings with setting_key='inventory'",
    ).toBe(true);
  });

  it("ensure_inventory_gl_accounts never creates an adjustment account with an ineligible detail_type", () => {
    // account_role_eligibility seeds role_key='inventory_adjustment' with
    // detail_types: other_business_expenses, cost_of_sales_other, other_expense.
    // If a migration's ensure_inventory_gl_accounts body inserts an account
    // tied to setting_key='inventory_adjustment' using detail_type
    // 'inventory_adjustment' (or any other non-eligible value), the
    // validate_default_account_setting trigger will reject the UPSERT and
    // opening-stock posting will fail. Guard against regressing.
    const ELIGIBLE = new Set([
      "other_business_expenses",
      "cost_of_sales_other",
      "other_expense",
    ]);

    const helperDefiners = allMigrations.filter((f) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      return /CREATE OR REPLACE FUNCTION public\.ensure_inventory_gl_accounts/.test(
        sql,
      );
    });

    // Only the latest definer is authoritative; older ones are superseded.
    const latest = helperDefiners.sort()[helperDefiners.length - 1];
    expect(
      latest,
      "Expected at least one ensure_inventory_gl_accounts definer migration",
    ).toBeTruthy();

    const sql = readFileSync(join(MIGRATIONS_DIR, latest!), "utf8");

    const detailTypes = new Set<string>();

    // Older definers inserted accounts inline; newer definers route through
    // upsert_system_account(role, account_type, detail_type, ...). Capture both
    // forms so the guard verifies the accounting contract instead of a syntax
    // shape.
    const segments = sql.split(/RETURNING id INTO v_adj/);
    for (let i = 0; i < segments.length - 1; i++) {
      const head = segments[i];
      const valuesIdx = head.lastIndexOf("VALUES");
      if (valuesIdx < 0) continue;
      const block = head.slice(valuesIdx);
      const detailTypeMatch = block.match(/'([a-z_]+)'\s*,\s*v_code/);
      if (detailTypeMatch) detailTypes.add(detailTypeMatch[1]);
    }

    for (const m of sql.matchAll(/upsert_system_account\([\s\S]*?'inventory_adjustment'[\s\S]*?'expense'\s*,\s*'([a-z_]+)'/g)) {
      detailTypes.add(m[1]);
    }

    expect(
      detailTypes.size,
      "Expected ensure_inventory_gl_accounts to provision/select an inventory_adjustment account",
    ).toBeGreaterThan(0);

    for (const dt of detailTypes) {
      expect(
        ELIGIBLE.has(dt),
        `ensure_inventory_gl_accounts adjustment path uses detail_type='${dt}', which is not in account_role_eligibility for role 'inventory_adjustment' (allowed: ${[...ELIGIBLE].join(", ")}).`,
      ).toBe(true);
    }
  });

  it("ensure_inventory_gl_accounts provisions the cogs role alongside inventory + inventory_adjustment", () => {
    const helperDefiners = allMigrations.filter((f) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      return /CREATE OR REPLACE FUNCTION public\.ensure_inventory_gl_accounts/.test(
        sql,
      );
    });
    const latest = helperDefiners.sort()[helperDefiners.length - 1]!;
    const sql = readFileSync(join(MIGRATIONS_DIR, latest), "utf8");

    expect(
      /'cogs'\s*,\s*v_cogs/.test(sql),
      "Expected ensure_inventory_gl_accounts to UPSERT default_account_settings with setting_key='cogs'",
    ).toBe(true);
  });

  it("latest physical_count_post uses canonical settings bindings, not the legacy default_accounts resolver", () => {
    const definers = allMigrations.filter((f) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      return /CREATE OR REPLACE FUNCTION public\.physical_count_post\(p_count_id uuid, p_user_id uuid\)/.test(sql);
    });
    const latest = definers.sort()[definers.length - 1];
    expect(latest, "Expected a physical_count_post definer migration").toBeTruthy();

    const sql = readFileSync(join(MIGRATIONS_DIR, latest!), "utf8");
    const start = sql.search(/CREATE OR REPLACE FUNCTION public\.physical_count_post\(p_count_id uuid, p_user_id uuid\)/);
    const end = sql.indexOf("GRANT EXECUTE ON FUNCTION public.physical_count_post", start);
    const body = sql.slice(start, end > start ? end : undefined);

    expect(body).toMatch(/_resolve_canonical_default_account\(\s*'inventory'/);
    expect(body).toMatch(/_resolve_canonical_default_account\(\s*'inventory_adjustment'/);
    expect(body).not.toMatch(/resolve_default_account\(/);
    expect(body).not.toMatch(/'inventory_asset'/);
    expect(body).not.toMatch(/\bphysical_count_id\b/);
    expect(body).toMatch(/\bcount_id\s*=\s*p_count_id\b/);
  });

  it("latest physical count preflight, preview, and post share the same canonical inventory keys", () => {
    const latest = allMigrations
      .filter((f) => {
        const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        return sql.includes("CREATE OR REPLACE FUNCTION public.physical_count_preflight") &&
          sql.includes("CREATE OR REPLACE FUNCTION public.physical_count_preview_je") &&
          sql.includes("CREATE OR REPLACE FUNCTION public.physical_count_post");
      })
      .sort()
      .at(-1);
    expect(latest, "Expected a unified physical count posting repair migration").toBeTruthy();

    const sql = readFileSync(join(MIGRATIONS_DIR, latest!), "utf8");
    const canonicalInventoryUses = sql.match(/_resolve_canonical_default_account\(\s*'inventory'/g) ?? [];
    const canonicalAdjustmentUses = sql.match(/_resolve_canonical_default_account\(\s*'inventory_adjustment'/g) ?? [];

    expect(canonicalInventoryUses.length).toBeGreaterThanOrEqual(3);
    expect(canonicalAdjustmentUses.length).toBeGreaterThanOrEqual(3);
    expect(sql).not.toMatch(/default_accounts/);
  });
});

