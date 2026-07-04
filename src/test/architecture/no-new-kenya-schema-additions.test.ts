/**
 * Architecture guard — Phase 1 freeze on new Kenya-coded schema/data
 *
 * Per the architecture audit (.lovable/plan.md), Kenya statutory concepts
 * (paye, nssf, nhif, shif, housing_levy, personal_relief, employer_nita_*)
 * leaked into core schema and registries. Phase 1 freezes any NEW migration
 * from adding more.
 *
 * Allowed: any migration with a filename timestamp <= MIGRATION_CUTOFF.
 * Forbidden in newer migrations:
 *   - ADD COLUMN with a Kenya statutory name on employees / payroll_runs /
 *     payslips. New statutory IDs must go into employee_statutory_identifiers.
 *   - Raw INSERT/UPDATE/DELETE on payroll_statutory_rules outside the
 *     install-localization-pack edge function. (DDL on the table is allowed.)
 *   - INSERT INTO system_account_roles whose code or description mentions
 *     a country (e.g., 'employer_nita_expense', '(Kenya)', etc.) — these
 *     must be installed by a localization pack, not by a core migration.
 *
 * If you need to add a country-specific concept, ship it in a localization
 * pack manifest under localization/seeds/<country>/ — not in a core migration.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Anything <= this timestamp is the historical baseline and is allowlisted.
// This is the latest migration in the repo at the time of the architecture
// audit. Bump it ONLY if you have an architecture-approved exception.
const MIGRATION_CUTOFF = "20260601092257";

const MIGRATIONS_DIR = "supabase/migrations";

// Kenya statutory tokens used as column names today.
const FORBIDDEN_COLUMN_TOKENS = [
  "paye",
  "nssf",
  "nhif",
  "shif",
  "housing_levy",
  "personal_relief",
  "insurance_relief",
  "nita",
  "sha_",
];

// Country names / ISO codes that should never appear as identifiers inside
// new INSERTs to system_account_roles.
const COUNTRY_HINTS = [
  /\(kenya\)/i,
  /\(ghana\)/i,
  /\(nigeria\)/i,
  /\(tanzania\)/i,
  /\(uganda\)/i,
  /\(south africa\)/i,
  /\(brazil\)/i,
  /\(india\)/i,
];

function listNewMigrations(): { name: string; path: string; sql: string }[] {
  const entries = readdirSync(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => {
      // Filename starts with a timestamp like 20260601080327_...
      const ts = f.slice(0, 14);
      return /^\d{14}$/.test(ts) && ts > MIGRATION_CUTOFF;
    })
    .map((f) => ({
      name: f,
      path: join(MIGRATIONS_DIR, f),
      sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8"),
    }));
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)--[^\n]*/g, "$1");
}

describe("phase 1 freeze on new Kenya-coded schema/data", () => {
  it("no new migration adds a Kenya-named column to core payroll tables", () => {
    const offenders: string[] = [];
    for (const m of listNewMigrations()) {
      const sql = stripSqlComments(m.sql);
      // Match: ALTER TABLE ... ADD COLUMN <name> ... where <name> contains a token.
      const addCol = /alter\s+table\s+[\w."]+\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?["]?(\w+)["]?/gi;
      let match: RegExpExecArray | null;
      while ((match = addCol.exec(sql))) {
        const col = match[1].toLowerCase();
        if (FORBIDDEN_COLUMN_TOKENS.some((t) => col.includes(t))) {
          offenders.push(`${m.name}: ADD COLUMN ${col}`);
        }
      }
      // Match: CREATE TABLE ... with a forbidden column name in the body.
      // Conservative: only flag columns that LOOK like statutory names.
      const createTableBodies = sql.match(/create\s+table\s+[^(]+\(([\s\S]*?)\);/gi) ?? [];
      for (const body of createTableBodies) {
        for (const tok of FORBIDDEN_COLUMN_TOKENS) {
          // word boundary, followed by a type-ish token (text/numeric/uuid/jsonb/timestamp/boolean/date/integer)
          const re = new RegExp(
            `\\b\\w*${tok}\\w*\\s+(text|numeric|uuid|jsonb|timestamp|boolean|date|integer|bigint|smallint|decimal)`,
            "i"
          );
          if (re.test(body)) {
            offenders.push(`${m.name}: CREATE TABLE column matching /${tok}/`);
            break;
          }
        }
      }
    }
    expect(
      offenders,
      `New migrations must not add Kenya-named columns. Use employee_statutory_identifiers + payroll_statutory_rules + localization packs instead.\n${offenders.join(
        "\n"
      )}`
    ).toEqual([]);
  });

  it("no new migration writes data into payroll_statutory_rules directly", () => {
    const offenders: string[] = [];
    for (const m of listNewMigrations()) {
      const sql = stripSqlComments(m.sql);
      // DML on payroll_statutory_rules from a migration is forbidden.
      // Pack installs must go through supabase/functions/install-localization-pack.
      const dml = /\b(insert\s+into|update|delete\s+from)\s+(public\.)?payroll_statutory_rules\b/i;
      if (dml.test(sql)) {
        offenders.push(m.name);
      }
    }
    expect(
      offenders,
      `Migrations may not write to payroll_statutory_rules. Author or update a localization pack and install via the pack installer.\n${offenders.join(
        "\n"
      )}`
    ).toEqual([]);
  });

  it("no new migration inserts country-specific entries into system_account_roles", () => {
    const offenders: string[] = [];
    for (const m of listNewMigrations()) {
      const sql = stripSqlComments(m.sql);
      // Find INSERT INTO system_account_roles ... VALUES (...) blocks and
      // scan the VALUES content for country hints or known country tokens.
      const inserts = sql.match(
        /insert\s+into\s+(public\.)?system_account_roles[\s\S]*?;/gi
      );
      if (!inserts) continue;
      for (const block of inserts) {
        if (COUNTRY_HINTS.some((re) => re.test(block))) {
          offenders.push(`${m.name}: insert mentions a country name`);
        }
        for (const tok of FORBIDDEN_COLUMN_TOKENS) {
          // role codes are typically lowercase identifiers; flag if a token
          // appears as part of a quoted code literal.
          const re = new RegExp(`'[^']*${tok}[^']*'`, "i");
          if (re.test(block)) {
            offenders.push(`${m.name}: role code contains /${tok}/`);
            break;
          }
        }
      }
    }
    expect(
      offenders,
      `system_account_roles is a global registry. Country-specific roles must be installed by a localization pack, not a core migration.\n${offenders.join(
        "\n"
      )}`
    ).toEqual([]);
  });

  // ADR 0057 — no direct CoA writes into every tenant from a core migration.
  // Country-specific accounts must be seeded by install_localization_pack_atomic
  // from localization_pack_account_templates, never by a loop over businesses.
  it("no new migration inserts into public.accounts inside a per-business loop", () => {
    const offenders: string[] = [];
    for (const m of listNewMigrations()) {
      const sql = stripSqlComments(m.sql);
      // Look for a FOR ... IN ... businesses ... LOOP that contains an
      // INSERT INTO public.accounts. Conservative: require both markers in
      // the same DO/FOR block.
      const forBlocks = sql.match(/for\s+\w+\s+in[\s\S]*?end\s+loop\s*;/gi) ?? [];
      for (const block of forBlocks) {
        const iteratesBusinesses = /\bbusinesses\b/i.test(block);
        const insertsAccounts = /insert\s+into\s+(public\.)?accounts\b/i.test(block);
        if (iteratesBusinesses && insertsAccounts) {
          offenders.push(`${m.name}: INSERT INTO public.accounts inside FOR ... businesses ... LOOP`);
        }
      }
    }
    expect(
      offenders,
      `Direct CoA writes into every tenant are forbidden (ADR 0057). Seed accounts via localization_pack_account_templates + install_localization_pack_atomic instead.\n${offenders.join(
        "\n"
      )}`
    ).toEqual([]);
  });
});
