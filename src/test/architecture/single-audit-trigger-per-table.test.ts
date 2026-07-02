/**
 * Architecture guard — one audit trigger per sensitive settings table.
 *
 * Background: a previous round of migrations attached three different
 * triggers (`audit_<t>_settings`, `trg_audit_<t>`, `trg_audit_settings_change`)
 * to the same eight tables, all calling `audit_settings_change()`. Every
 * row change therefore wrote three identical rows to `settings_audit_log`,
 * silently corrupting any "diff vs previous entry" reasoning over the log.
 *
 * Migration `20260427103557_dedupe_audit_triggers_and_trial_expiry` drops
 * the legacy trigger names. This test guards against the regression by
 * scanning the migration list and asserting that, after the dedupe
 * migration, no later migration re-introduces a duplicate.
 *
 * We intentionally do NOT try to fully simulate Postgres trigger state by
 * static SQL parsing — historical migrations use a mix of static
 * `CREATE TRIGGER` and `EXECUTE format(...)` patterns and reproducing the
 * full state machine in a test would itself be a maintenance hazard. The
 * live-database invariant is verified separately (see plan notes) and the
 * static check below is a forward-only guard: anything added AFTER the
 * dedupe migration must not call `audit_settings_change` more than once
 * per sensitive table.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const SENSITIVE_TABLES = [
  "businesses",
  "branches",
  "branch_setting_overrides",
  "tax_rates",
  "payment_provider_configs",
  "default_account_settings",
  "notification_alert_settings",
  "pos_settings",
];

const DEDUPE_MIGRATION_PREFIX = "20260427103557";

describe("audit_settings_change trigger duplication guard", () => {
  it("no migration after the dedupe migration adds a 2nd audit trigger to a sensitive table", () => {
    const migrationsDir = join(process.cwd(), "supabase", "migrations");
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const dedupeIdx = files.findIndex((f) => f.startsWith(DEDUPE_MIGRATION_PREFIX));
    expect(
      dedupeIdx,
      "Dedupe migration must exist; if you intentionally renamed it, update DEDUPE_MIGRATION_PREFIX in this test.",
    ).toBeGreaterThanOrEqual(0);

    const after = files.slice(dedupeIdx + 1);
    // Per-table count of NEW audit_settings_change creations after the dedupe.
    const perTable = new Map<string, number>();

    // Match both static and dynamic patterns.
    const patterns: RegExp[] = [
      // static: CREATE TRIGGER <name> ... ON public.<table> ... audit_settings_change
      /CREATE\s+TRIGGER\s+[A-Za-z0-9_]+[\s\S]*?ON\s+public\.([A-Za-z0-9_"]+)[\s\S]*?audit_settings_change\b/gi,
      // dynamic: EXECUTE format('CREATE TRIGGER ...') paired with a tables array
      // — we approximate by counting any `audit_settings_change` reference in
      // the same DO block as a tables array containing the sensitive name.
    ];

    for (const f of after) {
      const sql = readFileSync(join(migrationsDir, f), "utf8");
      for (const re of patterns) {
        for (const m of sql.matchAll(re)) {
          const tbl = m[1].replace(/"/g, "");
          if (SENSITIVE_TABLES.includes(tbl)) {
            perTable.set(tbl, (perTable.get(tbl) ?? 0) + 1);
          }
        }
      }
      // DO-block heuristic for dynamic creation.
      for (const block of sql.matchAll(/DO\s+\$\$([\s\S]*?)\$\$/gi)) {
        const body = block[1];
        if (!/CREATE\s+TRIGGER[\s\S]*?audit_settings_change/i.test(body)) continue;
        const arr = /tables\s+text\[\]\s*:=\s*ARRAY\s*\[([^\]]+)\]/i.exec(body);
        if (!arr) continue;
        const tables = [...arr[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
        for (const tbl of tables) {
          if (SENSITIVE_TABLES.includes(tbl)) {
            perTable.set(tbl, (perTable.get(tbl) ?? 0) + 1);
          }
        }
      }
    }

    const offenders = [...perTable.entries()].filter(([, n]) => n > 0);
    expect(
      offenders,
      `After dedupe (${DEDUPE_MIGRATION_PREFIX}), no new audit_settings_change ` +
        `trigger should be added to a sensitive table without a paired ` +
        `DROP of the prior triggers. Offenders:\n  ` +
        offenders.map(([t, n]) => `${t}: +${n}`).join("\n  "),
    ).toEqual([]);
  });
});
