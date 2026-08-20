/**
 * Shared enum-literal ratchet for finance/sales SQL.
 *
 * `invoices.status`, `estimates.status` and `credit_notes.status` are Postgres
 * enums. Comparing them against a label that does not exist raises 22P02 at
 * plan time, which PostgREST returns as HTTP 400 — the whole report fails even
 * when the tables are empty. This has now broken two surfaces (Sales Overview
 * and Sales Analysis), so the check lives in one place and every finance
 * function that filters on these columns is asserted against it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/** Real labels of each status enum, as defined in the database. */
export const ENUM_LABELS: Record<string, string[]> = {
  invoices: [
    "draft",
    "sent",
    "viewed",
    "partial",
    "paid",
    "overdue",
    "cancelled",
    "confirmed",
    "voided",
  ],
  estimates: ["draft", "sent", "viewed", "accepted", "rejected", "expired", "converted"],
  credit_notes: ["draft", "issued", "applied", "void", "refunded"],
};

/** Aliases finance SQL binds to each enum-backed table. */
export const TABLE_ALIASES: Record<string, string[]> = {
  invoices: ["", "i.", "si."],
  estimates: ["", "e."],
  credit_notes: ["", "n.", "c.", "cn."],
};

/** Newest migration that defines `public.<fn>`; throws when none does. */
export function latestMigrationDefining(fn: string): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(MIGRATIONS_DIR, files[i]), "utf8");
    if (sql.includes(`FUNCTION public.${fn}`)) return sql;
  }
  throw new Error(`no migration defines ${fn}`);
}

/** Every status literal compared against one of the given aliases. */
export function statusLiterals(sql: string, prefixes: string[]): string[] {
  const found: string[] = [];
  for (const prefix of prefixes) {
    // An empty prefix means the bare column; make sure it is not the tail of
    // another alias (`i.status` must not be read as an aliasless `status`).
    const escaped = prefix === "" ? "(?<![\\w.])" : prefix.replace(".", "\\.");
    const re = new RegExp(
      `${escaped}status\\s*(?:NOT\\s+)?IN\\s*\\(([^)]*)\\)|${escaped}status\\s*(?:<>|=)\\s*'([^']+)'`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) {
      if (m[2]) found.push(m[2]);
      else for (const lit of m[1].matchAll(/'([^']*)'/g)) found.push(lit[1]);
    }
  }
  return found;
}

/** Labels used against `<table>.status` that are not real enum labels. */
export function invalidStatusLiterals(sql: string, table: string): string[] {
  // Slice the SQL to statements that mention the table so aliasless
  // `status IN (...)` predicates are attributed to the right enum.
  const blocks = sql.split(";").filter((stmt) => new RegExp(`public\\.${table}\\b`).test(stmt));
  const used = new Set(blocks.flatMap((b) => statusLiterals(b, TABLE_ALIASES[table])));
  return [...used].filter((label) => label !== "" && !ENUM_LABELS[table].includes(label));
}
